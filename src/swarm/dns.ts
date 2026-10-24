/**
 * Agent-DNS: LAN discovery for actor sessions.
 *
 * UDP multicast beacons carry compact records: which actor addresses a host
 * serves, what they can do, their role and load. This is discovery only — mail
 * still moves through the actor mailbox / actord. Keeping discovery and
 * delivery separate means a forged or noisy beacon can at worst send a plan
 * toward a peer that does not answer; it cannot inject a message into a
 * session's inbox.
 *
 * Security: when OPENCC_DNS_TOKEN (or OPENCC_ACTORD_TOKEN) is set, every
 * beacon is HMAC-signed over kind|node|sentAt|nonce|recordsHash and a ±2 minute
 * clock window. Unsigned or stale beacons are dropped.
 */

import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'crypto'
import { readdir, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getLocalNodeName, nodeActorAddress } from '../actor/types.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { loadSwarmProfileSync } from './profile.js'

export const DNS_VERSION = 1
export const DEFAULT_DNS_GROUP = '239.255.77.77'
export const DEFAULT_DNS_PORT = 47777
export const DEFAULT_DNS_INTERVAL_MS = 5_000
export const DNS_CLOCK_SKEW_MS = 120_000
const MAX_PACKET_BYTES = 1400
const LOCK_OPTIONS = { retries: { retries: 20, minTimeout: 5, maxTimeout: 80 } }

export type AgentStatus = 'idle' | 'busy' | 'offline'

export type AgentDnsRecord = {
  address: string
  team: string
  name: string
  /** Host that serves the address. */
  node: string
  capabilities: string[]
  roles: string[]
  load: number
  status: AgentStatus
  updatedAt: string
  ttlMs: number
  seq: number
}

export type AgentDnsRecordStored = AgentDnsRecord & {
  receivedAt: string
}

export type AgentDnsBeaconKind =
  | 'agent-dns.beacon'
  | 'agent-dns.query'
  | 'agent-dns.bye'

export type AgentDnsBeacon = {
  v: number
  kind: AgentDnsBeaconKind
  node: string
  sentAt: string
  nonce: string
  records: AgentDnsRecord[]
  sig?: string
}

export type DnsConfig = {
  group: string
  port: number
  intervalMs: number
  ttlMs: number
  token?: string
  disabled: boolean
}

export function getDnsConfig(): DnsConfig {
  const profile = loadSwarmProfileSync()
  const intervalMs =
    Number.parseInt(process.env.OPENCC_DNS_INTERVAL_MS ?? '', 10) ||
    profile.intervalMs ||
    DEFAULT_DNS_INTERVAL_MS
  return {
    group:
      process.env.OPENCC_DNS_GROUP?.trim() ||
      profile.group ||
      DEFAULT_DNS_GROUP,
    port:
      Number.parseInt(process.env.OPENCC_DNS_PORT ?? '', 10) ||
      profile.port ||
      DEFAULT_DNS_PORT,
    intervalMs,
    ttlMs:
      Number.parseInt(process.env.OPENCC_DNS_TTL_MS ?? '', 10) ||
      profile.ttlMs ||
      intervalMs * 3,
    token:
      process.env.OPENCC_DNS_TOKEN?.trim() ||
      process.env.OPENCC_ACTORD_TOKEN?.trim() ||
      profile.token ||
      undefined,
    disabled:
      process.env.OPENCC_DNS_DISABLED === '1' || profile.disabled === true,
  }
}

function recordsHash(records: readonly AgentDnsRecord[]): string {
  const sorted = [...records].sort((a, b) => a.address.localeCompare(b.address))
  return createHash('sha256').update(jsonStringify(sorted)).digest('hex')
}

function signaturePayload(beacon: AgentDnsBeacon): string {
  return [
    beacon.v,
    beacon.kind,
    beacon.node,
    beacon.sentAt,
    beacon.nonce,
    recordsHash(beacon.records),
  ].join('|')
}

export function signBeacon(beacon: AgentDnsBeacon, token: string): string {
  return createHmac('sha256', token)
    .update(signaturePayload(beacon))
    .digest('hex')
}

export function verifyBeacon(
  beacon: AgentDnsBeacon,
  token: string | undefined,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (beacon.v !== DNS_VERSION) return { ok: false, reason: 'version' }
  if (!Array.isArray(beacon.records)) return { ok: false, reason: 'records' }
  const sentAt = Date.parse(beacon.sentAt)
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'sentAt' }
  if (Math.abs(now - sentAt) > DNS_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'clock_skew' }
  }
  if (!token) return { ok: true }
  if (!beacon.sig) return { ok: false, reason: 'missing_sig' }
  const expected = Buffer.from(signBeacon(beacon, token), 'hex')
  const actual = Buffer.from(beacon.sig, 'hex')
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return { ok: false, reason: 'bad_sig' }
  }
  return { ok: true }
}

export function buildBeacon(
  kind: AgentDnsBeaconKind,
  records: readonly AgentDnsRecord[],
  config: DnsConfig,
  node = getLocalNodeName(),
): AgentDnsBeacon {
  const beacon: AgentDnsBeacon = {
    v: DNS_VERSION,
    kind,
    node,
    sentAt: new Date().toISOString(),
    nonce: randomUUID(),
    records: [...records],
  }
  if (config.token) beacon.sig = signBeacon(beacon, config.token)
  return trimBeacon(beacon)
}

/** Keep the packet inside one MTU; drop the least useful records first. */
function trimBeacon(beacon: AgentDnsBeacon): AgentDnsBeacon {
  const priority = (record: AgentDnsRecord): number => {
    const status = record.status === 'idle' ? 0 : record.status === 'busy' ? 1 : 2
    return status * 100 - record.capabilities.length
  }
  const records = [...beacon.records].sort((a, b) => priority(a) - priority(b))
  while (records.length > 0) {
    beacon.records = records
    if (Buffer.byteLength(jsonStringify(beacon), 'utf8') <= MAX_PACKET_BYTES) {
      break
    }
    records.pop()
  }
  beacon.records = records
  return beacon
}

export function encodeBeacon(beacon: AgentDnsBeacon): Buffer {
  return Buffer.from(jsonStringify(beacon), 'utf8')
}

export function parseBeacon(raw: Buffer | string): AgentDnsBeacon | null {
  try {
    const parsed = jsonParse(
      typeof raw === 'string' ? raw : raw.toString('utf8'),
    ) as Partial<AgentDnsBeacon>
    if (
      parsed.v !== DNS_VERSION ||
      typeof parsed.kind !== 'string' ||
      !parsed.kind.startsWith('agent-dns.') ||
      typeof parsed.node !== 'string' ||
      typeof parsed.sentAt !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      !Array.isArray(parsed.records)
    ) {
      return null
    }
    return {
      v: DNS_VERSION,
      kind: parsed.kind as AgentDnsBeaconKind,
      node: parsed.node,
      sentAt: parsed.sentAt,
      nonce: parsed.nonce,
      records: parsed.records as AgentDnsRecord[],
      sig: typeof parsed.sig === 'string' ? parsed.sig : undefined,
    }
  } catch {
    return null
  }
}

// ── Local registry (records each session wants announced) ────────────

export function getDnsRoot(): string {
  return join(getClaudeConfigHomeDir(), 'agents-dns')
}

function localDir(): string {
  return join(getDnsRoot(), 'local')
}

function localFile(address: string): string {
  return join(localDir(), `${createHash('sha256').update(address).digest('hex').slice(0, 20)}.json`)
}

export async function announceLocalRecord(input: {
  address: string
  team: string
  name: string
  capabilities?: string[]
  roles?: string[]
  load?: number
  status?: AgentStatus
  ttlMs?: number
  node?: string
}): Promise<AgentDnsRecord> {
  const config = getDnsConfig()
  const record: AgentDnsRecord = {
    address: input.address,
    team: input.team,
    name: input.name,
    node: input.node ?? getLocalNodeName(),
    capabilities: input.capabilities ?? ['agent'],
    roles: input.roles ?? [],
    load: input.load ?? 0,
    status: input.status ?? 'idle',
    updatedAt: new Date().toISOString(),
    ttlMs: input.ttlMs ?? config.ttlMs,
    seq: Date.now(),
  }
  await mkdir(localDir(), { recursive: true })
  await writeFile(localFile(input.address), jsonStringify(record, null, 2), 'utf8')
  return record
}

export async function removeLocalRecord(address: string): Promise<void> {
  try {
    await rm(localFile(address))
  } catch {
    // Already gone.
  }
}

export async function readLocalRecords(now = Date.now()): Promise<AgentDnsRecord[]> {
  let files: string[] = []
  try {
    files = await readdir(localDir())
  } catch {
    return []
  }
  const records: AgentDnsRecord[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const record = jsonParse(
        await readFile(join(localDir(), file), 'utf8'),
      ) as AgentDnsRecord
      if (!record?.address || !Number.isFinite(record.ttlMs)) continue
      if (Date.parse(record.updatedAt) + record.ttlMs <= now) continue
      records.push(record)
    } catch {
      // A half-written registry file is not worth failing discovery over.
    }
  }
  return records
}

// ── Peer cache ───────────────────────────────────────────────────────

type DnsCache = { v: number; records: Record<string, AgentDnsRecordStored> }

function cachePath(): string {
  return join(getDnsRoot(), 'peers.json')
}

async function ensureCache(): Promise<void> {
  await mkdir(getDnsRoot(), { recursive: true })
  try {
    await writeFile(cachePath(), jsonStringify({ v: 1, records: {} }), {
      flag: 'wx',
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function readCache(): Promise<DnsCache> {
  try {
    const parsed = jsonParse(await readFile(cachePath(), 'utf8')) as DnsCache
    return {
      v: 1,
      records:
        parsed?.records && typeof parsed.records === 'object'
          ? parsed.records
          : {},
    }
  } catch {
    return { v: 1, records: {} }
  }
}

export async function mergeBeaconRecords(
  beacon: AgentDnsBeacon,
  now = Date.now(),
): Promise<{ accepted: number; rejected: number }> {
  await ensureCache()
  const release = await lockfile.lock(cachePath(), LOCK_OPTIONS)
  try {
    const cache = await readCache()
    const localNode = getLocalNodeName()
    let accepted = 0
    let rejected = 0
    for (const incoming of beacon.records) {
      if (
        !incoming?.address ||
        !incoming.team ||
        !incoming.name ||
        incoming.node !== beacon.node
      ) {
        rejected++
        continue
      }
      // Multicast loopback returns our own beacon. Local actors are already in
      // the mailbox presence list; caching them as peers would let a plan
      // select a duplicate copy of an address it already knows.
      if (beacon.node === localNode) {
        rejected++
        continue
      }
      const updated = Date.parse(incoming.updatedAt)
      if (
        !Number.isFinite(updated) ||
        !Number.isFinite(incoming.ttlMs) ||
        updated + incoming.ttlMs <= now
      ) {
        rejected++
        continue
      }
      const existing = cache.records[incoming.address]
      if (
        existing &&
        (existing.seq > incoming.seq ||
          (existing.seq === incoming.seq &&
            Date.parse(existing.updatedAt) >= updated))
      ) {
        rejected++
        continue
      }
      cache.records[incoming.address] = {
        ...incoming,
        capabilities: Array.isArray(incoming.capabilities)
          ? incoming.capabilities.slice(0, 32)
          : [],
        roles: Array.isArray(incoming.roles) ? incoming.roles.slice(0, 16) : [],
        receivedAt: new Date(now).toISOString(),
      }
      accepted++
    }
    await writeFile(cachePath(), jsonStringify(cache, null, 2), 'utf8')
    return { accepted, rejected }
  } finally {
    await release()
  }
}

export async function purgeNodeRecords(
  node: string,
  now = Date.now(),
): Promise<number> {
  await ensureCache()
  const release = await lockfile.lock(cachePath(), LOCK_OPTIONS)
  try {
    const cache = await readCache()
    let removed = 0
    for (const [address, record] of Object.entries(cache.records)) {
      if (record.node === node) {
        delete cache.records[address]
        removed++
      }
    }
    await writeFile(cachePath(), jsonStringify(cache, null, 2), 'utf8')
    return removed
  } finally {
    await release()
  }
}

export async function pruneDnsCache(now = Date.now()): Promise<number> {
  await ensureCache()
  const release = await lockfile.lock(cachePath(), LOCK_OPTIONS)
  try {
    const cache = await readCache()
    let removed = 0
    for (const [address, record] of Object.entries(cache.records)) {
      // Keep records a little past their own TTL: one missed beacon should not
      // erase a peer, but three should.
      if (
        Date.parse(record.updatedAt) + record.ttlMs * 3 <= now ||
        record.status === 'offline'
      ) {
        delete cache.records[address]
        removed++
      }
    }
    await writeFile(cachePath(), jsonStringify(cache, null, 2), 'utf8')
    return removed
  } finally {
    await release()
  }
}

export async function listDnsRecords(filter?: {
  team?: string
  capability?: string
  role?: string
  liveOnly?: boolean
  now?: number
}): Promise<AgentDnsRecordStored[]> {
  const now = filter?.now ?? Date.now()
  const cache = await readCache()
  return Object.values(cache.records)
    .filter(record => {
      if (filter?.team && record.team !== filter.team) return false
      if (
        filter?.capability &&
        !record.capabilities.includes(filter.capability)
      ) {
        return false
      }
      if (filter?.role && !record.roles.includes(filter.role)) return false
      if (
        filter?.liveOnly &&
        Date.parse(record.updatedAt) + record.ttlMs <= now
      ) {
        return false
      }
      return true
    })
    .sort((a, b) => a.address.localeCompare(b.address))
}

/** Address usable by the mailbox: local names stay bare, remote names get @node. */
export function routableAddress(record: AgentDnsRecordStored): string {
  return record.node === getLocalNodeName()
    ? record.address
    : nodeActorAddress(record.team, record.name, record.node)
}
