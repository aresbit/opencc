import { createHash } from 'crypto'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
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

export type ActorPresence = {
  address: string
  unread: number
  lastSeenAt?: string
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
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      const records = await this.read(path)
      const now = new Date().toISOString()
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
          found.push({
            address: raw.address,
            lastSeenAt:
              typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : undefined,
            unread: (await this.peek(raw.address)).length,
          })
        } catch {
          // A half-written or hand-edited presence file is not worth failing
          // discovery over.
        }
      }
    }
    return found.sort((a, b) => a.address.localeCompare(b.address))
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
