import { createHash } from 'crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { sanitizePathComponent } from '../utils/tasks.js'
import {
  ACTOR_PROTOCOL_VERSION,
  type ActorAddress,
  type ActorEnvelope,
  isExpiredActorEnvelope,
  parseActorAddress,
} from './types.js'

/** Sidecar marking an address as served; see announce(). */
const PRESENCE_SUFFIX = '.presence.json'

/** Sidecar holding envelopes that could not be delivered; see deadLetter(). */
const DEAD_SUFFIX = '.dead.json'

/** Sidecar holding delivery receipts addressed to a sender; see ack(). */
const ACK_SUFFIX = '.acks.json'

/**
 * How long a receipt is kept.
 *
 * Long enough to outlive any sender still blocking on it, short enough that
 * the file stays small. Senders wait seconds, not minutes.
 */
const ACK_RETENTION_MS = 10 * 60 * 1000

/** Upper bound on receipts per sender. */
const MAX_ACKS = 500

/**
 * How stale a presence heartbeat may be before its address counts as gone.
 *
 * Serving sessions re-announce every 30s, so three missed heartbeats is the
 * threshold. Too short and a busy session is declared dead mid-turn; too long
 * and a sender waits on a mailbox nobody is reading. This is the only thing
 * standing between `tx` and its old behaviour of reporting success for having
 * written a file into a directory nobody watches.
 */
export const PRESENCE_STALE_MS = 90 * 1000

export type ActorPresence = {
  address: string
  unread: number
  lastSeenAt?: string
  /** False when the heartbeat is older than PRESENCE_STALE_MS. */
  live?: boolean
}

/** Proof that a specific envelope reached a receiver that consumed it. */
export type DeliveryReceipt = {
  envelopeId: string
  ackedBy: string
  ackedAt: string
}

/** An envelope that will not be delivered, with the reason it was given up on. */
export type DeadLetter = {
  envelope: ActorEnvelope
  reason: 'expired' | 'receiver_retired' | 'unacked'
  deadAt: string
}

type StoredEnvelope = {
  envelope: ActorEnvelope
  receivedAt?: string
}

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}

/**
 * How long a claimed envelope is kept after delivery.
 *
 * Claimed records used to be kept forever, so a mailbox only ever grew and
 * every send and receive rewrote the whole file under a lock. Keeping them for
 * a window instead bounds the file, at the cost of bounding idempotency with
 * it: `send` dedupes on envelope id against the records still present, so a
 * duplicate of the *same* envelope id arriving after this window would be
 * delivered a second time. Retries in this system happen in seconds, so the
 * window is the dedupe guarantee that actually matters.
 */
const CLAIMED_RETENTION_MS = 5 * 60 * 1000

/** Upper bound on parked envelopes per address. */
const MAX_DEAD_LETTERS = 200

function isEnvelope(value: unknown): value is ActorEnvelope {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ActorEnvelope>
  return (
    item.v === ACTOR_PROTOCOL_VERSION &&
    typeof item.id === 'string' &&
    typeof item.from === 'string' &&
    typeof item.to === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.sentAt === 'string'
  )
}

export class LocalActorMailbox {
  readonly root: string

  constructor(root = join(getClaudeConfigHomeDir(), 'actors')) {
    this.root = root
  }

  /**
   * Sanitizing is lossy: every character outside [A-Za-z0-9_-] collapses to
   * '-', so `文档-opencc`, `下载-opencc` and `資料-opencc` all name the same
   * file. Sharing a mailbox is not a cosmetic problem — delivery is
   * at-most-once, so co-located actors would claim each other's envelopes.
   * Append a digest of the exact component when sanitizing changed anything,
   * which keeps the readable prefix and leaves clean ASCII names untouched.
   */
  private safeComponent(value: string): string {
    const sanitized = sanitizePathComponent(value)
    if (sanitized === value) return sanitized
    const digest = createHash('sha256').update(value).digest('hex').slice(0, 8)
    return `${sanitized}-${digest}`
  }

  private pathFor(address: ActorAddress): string {
    return join(
      this.root,
      this.safeComponent(address.team),
      `${this.safeComponent(address.name)}.json`,
    )
  }

  private async ensure(address: ActorAddress): Promise<string> {
    const path = this.pathFor(address)
    // Must agree with pathFor, or a non-ASCII team creates one directory and
    // the write targets another.
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, '[]', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return path
  }

  private async read(path: string): Promise<StoredEnvelope[]> {
    try {
      const parsed = jsonParse(await readFile(path, 'utf8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is StoredEnvelope =>
        Boolean(item && typeof item === 'object' && isEnvelope(item.envelope)),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async send(envelope: ActorEnvelope): Promise<void> {
    const address = parseActorAddress(envelope.to)
    if (address.transport !== 'local') {
      throw new Error('LocalActorMailbox only accepts actor:// destinations')
    }
    const path = await this.ensure(address)
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      const records = await this.read(path)
      if (!records.some(record => record.envelope.id === envelope.id)) {
        records.push({ envelope })
        await writeFile(path, jsonStringify(records, null, 2), 'utf8')
      }
    } finally {
      await release()
    }
  }

  /** Atomically claims unread messages. Each envelope is delivered at most once. */
  async receive(addressValue: string, limit = 1): Promise<ActorEnvelope[]> {
    const address = parseActorAddress(addressValue)
    if (address.transport !== 'local') {
      throw new Error('LocalActorMailbox only accepts actor:// addresses')
    }
    const path = await this.ensure(address)
    let expiredToPark: ActorEnvelope[] = []
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      const records = await this.read(path)
      const now = new Date().toISOString()
      // Expired-but-unread envelopes are about to be compacted out of the
      // file. Park them first: the sender was told the send succeeded, and
      // without a record it has no way to learn that it was not.
      expiredToPark = records
        .filter(
          record =>
            !record.receivedAt && isExpiredActorEnvelope(record.envelope),
        )
        .map(record => record.envelope)
      const selected = records
        .filter(
          record =>
            !record.receivedAt && !isExpiredActorEnvelope(record.envelope),
        )
        .slice(0, Math.max(1, limit))
      const selectedIds = new Set(selected.map(record => record.envelope.id))
      const compacted = records
        .filter(record => !isExpiredActorEnvelope(record.envelope))
        .map(record =>
          selectedIds.has(record.envelope.id)
            ? { ...record, receivedAt: now }
            : record,
        )
        .filter(
          record =>
            !record.receivedAt ||
            Date.parse(record.receivedAt) + CLAIMED_RETENTION_MS > Date.now(),
        )
      await writeFile(path, jsonStringify(compacted, null, 2), 'utf8')
      return selected.map(record => record.envelope)
    } finally {
      await release()
      // Outside the mailbox lock: deadLetter takes its own lock on a
      // different file, and taking the second while holding the first is how
      // two of these deadlock each other.
      if (expiredToPark.length > 0) {
        await this.deadLetter(addressValue, expiredToPark, 'expired')
      }
    }
  }

  /**
   * Marks exactly the listed envelopes as delivered.
   *
   * `receive` reads and claims in one locked step, which forces a caller that
   * wants to deliver before claiming to choose between losing messages and
   * claiming ones it never saw: anything that arrived between its read and its
   * claim would be marked delivered without being handled. Splitting the claim
   * out lets a poller peek without a lock, hand off what it actually saw, and
   * then retire those ids and nothing else.
   */
  async claim(addressValue: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const address = parseActorAddress(addressValue)
    if (address.transport !== 'local') {
      throw new Error('LocalActorMailbox only accepts actor:// addresses')
    }
    const wanted = new Set(ids)
    const path = await this.ensure(address)
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      const records = await this.read(path)
      const now = new Date().toISOString()
      const updated = records.map(record =>
        !record.receivedAt && wanted.has(record.envelope.id)
          ? { ...record, receivedAt: now }
          : record,
      )
      await writeFile(path, jsonStringify(updated, null, 2), 'utf8')
    } finally {
      await release()
    }
  }

  /**
   * Records that this address exists and is being served.
   *
   * Two things make presence a separate file rather than something derivable
   * from the mailbox. Filenames are lossy for non-ASCII names, so the
   * directory listing cannot reconstruct an address; and a session that has
   * never been written to has no mailbox at all, which is exactly the session
   * a peer needs to discover before it can send the first message.
   */
  async announce(addressValue: string): Promise<void> {
    const address = parseActorAddress(addressValue)
    if (address.transport !== 'local') return
    const path = this.presencePathFor(address)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      jsonStringify(
        { address: address.canonical, lastSeenAt: new Date().toISOString() },
        null,
        2,
      ),
      'utf8',
    )
  }

  /** Every announced local actor, with what is waiting for each. */
  async list(): Promise<ActorPresence[]> {
    let teams: string[]
    try {
      teams = await readdir(this.root)
    } catch {
      return []
    }

    const found: ActorPresence[] = []
    for (const team of teams) {
      let entries: string[]
      try {
        entries = await readdir(join(this.root, team))
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith(PRESENCE_SUFFIX)) continue
        try {
          const raw = jsonParse(
            await readFile(join(this.root, team, entry), 'utf8'),
          ) as { address?: unknown; lastSeenAt?: unknown }
          if (typeof raw.address !== 'string') continue
          const lastSeenAt =
            typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : undefined
          const seen = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN
          found.push({
            address: raw.address,
            lastSeenAt,
            unread: (await this.peek(raw.address)).length,
            // A stale entry is a session that exited without retiring. Saying
            // so here is what lets a sender pick a peer that will actually
            // read, instead of the first name in the list.
            live: Number.isFinite(seen) && Date.now() - seen <= PRESENCE_STALE_MS,
          })
        } catch {
          // A half-written or hand-edited presence file is not worth failing
          // discovery over.
        }
      }
    }
    return found.sort((a, b) => a.address.localeCompare(b.address))
  }

  /**
   * Create an empty JSON array file if it is not there yet.
   *
   * lockfile.lock() stats its target, so locking a sidecar that has never been
   * written throws ENOENT — which is exactly the first write, the one that
   * matters. `ensure()` does this for the mailbox itself; the sidecars need
   * the same treatment.
   */
  private async ensureFile(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, '[]', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  private ackPathFor(address: ActorAddress): string {
    return join(
      this.root,
      this.safeComponent(address.team),
      `${this.safeComponent(address.name)}${ACK_SUFFIX}`,
    )
  }

  /**
   * Record that `envelopeId` was consumed, in a file the SENDER reads.
   *
   * Receipts deliberately do not travel as envelopes. An ack-as-envelope lands
   * in the sender's inbox, where it competes with the inbox injection that
   * delivers real mail into the conversation — whichever ran first would claim
   * it, so a sender blocking on the receipt could lose it to its own poller,
   * and a receipt that did arrive would be shown to the model as if it were a
   * message. A sidecar keyed by sender address is read by exactly one party
   * and never reaches a transcript.
   */
  async ack(
    senderAddress: string,
    envelopeId: string,
    ackedBy: string,
  ): Promise<void> {
    const address = parseActorAddress(senderAddress)
    if (address.transport !== 'local') return
    const path = this.ackPathFor(address)
    await this.ensureFile(path)
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      let receipts: DeliveryReceipt[] = []
      try {
        const parsed = jsonParse(await readFile(path, 'utf8'))
        if (Array.isArray(parsed)) receipts = parsed as DeliveryReceipt[]
      } catch {
        // First receipt for this sender, or an unreadable file.
      }
      const cutoff = Date.now() - ACK_RETENTION_MS
      const kept = receipts.filter(
        receipt =>
          receipt?.envelopeId !== envelopeId &&
          Date.parse(receipt?.ackedAt ?? '') > cutoff,
      )
      kept.push({ envelopeId, ackedBy, ackedAt: new Date().toISOString() })
      await writeFile(
        path,
        jsonStringify(kept.slice(-MAX_ACKS), null, 2),
        'utf8',
      )
    } finally {
      await release()
    }
  }

  /** The receipt for `envelopeId`, or null if it has not been consumed. */
  async receiptFor(
    senderAddress: string,
    envelopeId: string,
  ): Promise<DeliveryReceipt | null> {
    const address = parseActorAddress(senderAddress)
    try {
      const parsed = jsonParse(await readFile(this.ackPathFor(address), 'utf8'))
      if (!Array.isArray(parsed)) return null
      return (
        (parsed as DeliveryReceipt[]).find(
          receipt => receipt?.envelopeId === envelopeId,
        ) ?? null
      )
    } catch {
      return null
    }
  }

  private deadPathFor(address: ActorAddress): string {
    return join(
      this.root,
      this.safeComponent(address.team),
      `${this.safeComponent(address.name)}${DEAD_SUFFIX}`,
    )
  }

  /**
   * Whether an address is currently served by a live session.
   *
   * `send` writes a file whether or not anything is reading it, so on its own
   * a successful send says only that the write succeeded. Callers that need
   * delivery — rather than enqueue — ask this first.
   */
  async isReachable(
    addressValue: string,
    staleMs = PRESENCE_STALE_MS,
  ): Promise<boolean> {
    const address = parseActorAddress(addressValue)
    if (address.transport !== 'local') return true // not ours to judge
    try {
      const raw = jsonParse(
        await readFile(this.presencePathFor(address), 'utf8'),
      ) as { lastSeenAt?: unknown }
      if (typeof raw.lastSeenAt !== 'string') return false
      const seen = Date.parse(raw.lastSeenAt)
      return Number.isFinite(seen) && Date.now() - seen <= staleMs
    } catch {
      return false
    }
  }

  /**
   * Park envelopes that will not be delivered, with the reason.
   *
   * Previously an envelope that expired was dropped inside `receive` while
   * compacting the file: the sender was told the send succeeded, the receiver
   * never saw it, and nothing anywhere recorded that it had existed. A sender
   * cannot retry what it cannot discover, so undeliverable mail is kept here
   * instead of deleted.
   */
  async deadLetter(
    addressValue: string,
    envelopes: readonly ActorEnvelope[],
    reason: DeadLetter['reason'],
  ): Promise<void> {
    if (envelopes.length === 0) return
    const address = parseActorAddress(addressValue)
    if (address.transport !== 'local') return
    const path = this.deadPathFor(address)
    await this.ensureFile(path)
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      let existing: DeadLetter[] = []
      try {
        const parsed = jsonParse(await readFile(path, 'utf8'))
        if (Array.isArray(parsed)) existing = parsed as DeadLetter[]
      } catch {
        // No dead-letter file yet, or an unreadable one; start fresh rather
        // than losing the envelopes we were asked to park.
      }
      const deadAt = new Date().toISOString()
      const known = new Set(existing.map(entry => entry.envelope?.id))
      for (const envelope of envelopes) {
        if (!known.has(envelope.id)) existing.push({ envelope, reason, deadAt })
      }
      // Bounded like the mailbox itself: a sender that never drains this must
      // not be able to grow the file without limit.
      const trimmed = existing.slice(-MAX_DEAD_LETTERS)
      await writeFile(path, jsonStringify(trimmed, null, 2), 'utf8')
    } finally {
      await release()
    }
  }

  /** Undeliverable envelopes parked for this address, oldest first. */
  async listDeadLetters(addressValue: string): Promise<DeadLetter[]> {
    const address = parseActorAddress(addressValue)
    try {
      const parsed = jsonParse(
        await readFile(this.deadPathFor(address), 'utf8'),
      )
      return Array.isArray(parsed) ? (parsed as DeadLetter[]) : []
    } catch {
      return []
    }
  }

  /**
   * Stop serving an address: drop its presence and park whatever is unread.
   *
   * A subagent's mailbox outlives the subagent. Without this its presence file
   * keeps advertising an actor that exited, and anything still unread sits in
   * a file nobody will ever open again.
   */
  async retire(addressValue: string): Promise<void> {
    const address = parseActorAddress(addressValue)
    if (address.transport !== 'local') return
    const pending = await this.peek(addressValue)
    if (pending.length > 0) {
      await this.deadLetter(addressValue, pending, 'receiver_retired')
      await this.claim(
        addressValue,
        pending.map(envelope => envelope.id),
      )
    }
    try {
      await rm(this.presencePathFor(address))
    } catch {
      // Never announced, or already retired.
    }
  }

  private presencePathFor(address: ActorAddress): string {
    return join(
      this.root,
      this.safeComponent(address.team),
      `${this.safeComponent(address.name)}${PRESENCE_SUFFIX}`,
    )
  }

  async peek(addressValue: string): Promise<ActorEnvelope[]> {
    const address = parseActorAddress(addressValue)
    const path = this.pathFor(address)
    return (await this.read(path))
      .filter(
        record =>
          !record.receivedAt && !isExpiredActorEnvelope(record.envelope),
      )
      .map(record => record.envelope)
  }
}
