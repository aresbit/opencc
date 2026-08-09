import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
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

type StoredEnvelope = {
  envelope: ActorEnvelope
  receivedAt?: string
}

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}

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

  private pathFor(address: ActorAddress): string {
    return join(
      this.root,
      sanitizePathComponent(address.team),
      `${sanitizePathComponent(address.name)}.json`,
    )
  }

  private async ensure(address: ActorAddress): Promise<string> {
    const path = this.pathFor(address)
    await mkdir(join(this.root, sanitizePathComponent(address.team)), {
      recursive: true,
    })
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
      await writeFile(path, jsonStringify(compacted, null, 2), 'utf8')
      return selected.map(record => record.envelope)
    } finally {
      await release()
    }
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
