import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getLocalNodeName } from '../../actor/types.js'
import {
  reloadSwarmProfileForTesting,
  writeDefaultSwarmProfile,
} from '../profile.js'
import {
  buildBeacon,
  encodeBeacon,
  getDnsConfig,
  listDnsRecords,
  mergeBeaconRecords,
  parseBeacon,
  pruneDnsCache,
  purgeNodeRecords,
  signBeacon,
  verifyBeacon,
  type AgentDnsBeacon,
  type AgentDnsRecord,
} from '../dns.js'

const config = {
  group: '239.255.77.77',
  port: 47777,
  intervalMs: 5000,
  ttlMs: 15000,
  token: 'test-token',
  disabled: false,
}

function record(overrides: Partial<AgentDnsRecord> = {}): AgentDnsRecord {
  const now = new Date().toISOString()
  return {
    address: 'actor://default/a',
    team: 'default',
    name: 'a',
    node: 'pc',
    capabilities: ['code', 'test'],
    roles: ['algorithm'],
    load: 0,
    status: 'idle',
    updatedAt: now,
    ttlMs: 15000,
    seq: Date.now(),
    ...overrides,
  }
}

function beacon(records: AgentDnsRecord[], node = 'pc'): AgentDnsBeacon {
  const result: AgentDnsBeacon = {
    v: 1,
    kind: 'agent-dns.beacon',
    node,
    sentAt: new Date().toISOString(),
    nonce: 'n1',
    records,
  }
  result.sig = signBeacon(result, config.token)
  return result
}

describe('Agent-DNS beacon security', () => {
  it('round-trips a signed beacon', () => {
    const packet = buildBeacon('agent-dns.beacon', [record()], config, 'pc')
    expect(verifyBeacon(packet, config.token).ok).toBe(true)
    expect(parseBeacon(encodeBeacon(packet))?.node).toBe('pc')
  })

  it('rejects a tampered record', () => {
    const packet = buildBeacon('agent-dns.beacon', [record()], config, 'pc')
    packet.records[0]!.capabilities = ['root']
    expect(verifyBeacon(packet, config.token)).toEqual({
      ok: false,
      reason: 'bad_sig',
    })
  })

  it('rejects a replayed beacon outside the clock window', () => {
    const packet = buildBeacon('agent-dns.beacon', [record()], config, 'pc')
    const old = Date.parse(packet.sentAt) + 10 * 60 * 1000
    expect(verifyBeacon(packet, config.token, old)).toEqual({
      ok: false,
      reason: 'clock_skew',
    })
  })

  it('accepts unsigned beacons when no token is configured', () => {
    const unsigned = { ...beacon([record()]) }
    delete unsigned.sig
    expect(verifyBeacon(unsigned, undefined).ok).toBe(true)
  })

  it('trims packets to one MTU', () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      record({
        address: `actor://default/agent-${index}`,
        name: `agent-${index}`,
        capabilities: Array.from({ length: 10 }, (_, i) => `cap-${index}-${i}`),
      }),
    )
    const packet = buildBeacon('agent-dns.beacon', records, config, 'pc')
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(1400)
    expect(packet.records.length).toBeLessThan(100)
  })
})

describe('Agent-DNS cache', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    previous = process.env.CLAUDE_CONFIG_DIR
    dir = await mkdtemp(join(tmpdir(), 'agent-dns-test-'))
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  })

  it('merges, filters, prunes and purges records', async () => {
    const now = Date.now()
    const good = record({ seq: 1, updatedAt: new Date(now).toISOString() })
    const merged = await mergeBeaconRecords(
      beacon([good], 'pc'),
      now,
    )
    expect(merged.accepted).toBe(1)

    expect(await listDnsRecords({ capability: 'test', liveOnly: true })).toHaveLength(1)
    expect(await listDnsRecords({ capability: 'math' })).toHaveLength(0)

    // Older sequence loses.
    const stale = record({ seq: 0, capabilities: ['math'] })
    const second = await mergeBeaconRecords(beacon([stale], 'pc'), now)
    expect(second.rejected).toBe(1)
    expect(await listDnsRecords({ capability: 'test' })).toHaveLength(1)

    // Node goodbye removes all of its records.
    expect(await purgeNodeRecords('pc')).toBe(1)
    expect(await listDnsRecords()).toHaveLength(0)
  })

  it('drops expired records and prunes them from the cache', async () => {
    const now = Date.now()
    const expired = record({
      updatedAt: new Date(now - 60_000).toISOString(),
      ttlMs: 1000,
    })
    const merged = await mergeBeaconRecords(beacon([expired], 'pc'), now)
    expect(merged.rejected).toBe(1)
    expect(await listDnsRecords({ now })).toHaveLength(0)
    expect(await pruneDnsCache(now)).toBe(0)
  })

  it('ignores its own multicast loopback', async () => {
    const local = record({ node: getLocalNodeName() })
    const merged = await mergeBeaconRecords(
      beacon([local], getLocalNodeName()),
      Date.now(),
    )
    expect(merged.accepted).toBe(0)
    expect(await listDnsRecords()).toHaveLength(0)
  })

  it('uses environment configuration', () => {
    process.env.OPENCC_DNS_PORT = '49999'
    process.env.OPENCC_DNS_INTERVAL_MS = '2000'
    const envConfig = getDnsConfig()
    expect(envConfig.port).toBe(49999)
    expect(envConfig.ttlMs).toBe(6000)
    delete process.env.OPENCC_DNS_PORT
    delete process.env.OPENCC_DNS_INTERVAL_MS
  })

  it('reads swarm.json when the environment is silent', async () => {
    delete process.env.OPENCC_DNS_PORT
    delete process.env.OPENCC_DNS_TOKEN
    delete process.env.OPENCC_ACTORD_TOKEN
    await writeFile(
      join(dir, 'swarm.json'),
      JSON.stringify({
        port: 49998,
        token: 'profile-token',
        intervalMs: 2000,
        capabilities: ['math'],
        roles: ['research'],
      }),
    )
    reloadSwarmProfileForTesting()
    const profileConfig = getDnsConfig()
    expect(profileConfig.port).toBe(49998)
    expect(profileConfig.token).toBe('profile-token')
    expect(profileConfig.ttlMs).toBe(6000)
  })

  it('creates a zero-config profile without overwriting', async () => {
    const first = await writeDefaultSwarmProfile()
    expect(first.created).toBe(true)
    const second = await writeDefaultSwarmProfile()
    expect(second.created).toBe(false)
    expect(second.profile.capabilities).toEqual(['code'])
    expect(second.profile.roles).toEqual(['generalist'])
  })
})
