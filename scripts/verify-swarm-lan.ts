#!/usr/bin/env bun
/**
 * LAN verification for the swarm stack.
 *
 *   bun run scripts/verify-swarm-lan.ts           # self-test, one machine
 *   bun run scripts/verify-swarm-lan.ts --join    # join the real LAN and list peers
 *
 * Self-test starts two daemons on the machine (different node names, separate
 * config dirs, same multicast port), then checks:
 *   - each side discovers the other
 *   - convergence time
 *   - TTL expiry after one side stops
 *   - a seeded A -> B -> D relay is forwarded and delivered
 *
 * Everything is zero-config: node names are generated, DNS is unsigned unless
 * --token is passed, and no environment variable is required.
 */

import { mkdtemp, readFile, rm } from 'fs/promises'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

type Args = {
  join: boolean
  durationMs: number
  port: number
  group?: string
  token?: string
  node?: string
  relay: boolean
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    join: false,
    durationMs: 15_000,
    port: 0,
    relay: true,
  }
  for (const arg of argv) {
    if (arg === '--join') args.join = true
    else if (arg === '--no-relay') args.relay = false
    else if (arg.startsWith('--duration=')) {
      args.durationMs = Number.parseInt(arg.slice('--duration='.length), 10) || 15_000
    } else if (arg.startsWith('--port=')) {
      args.port = Number.parseInt(arg.slice('--port='.length), 10) || 0
    } else if (arg.startsWith('--group=')) {
      args.group = arg.slice('--group='.length)
    } else if (arg.startsWith('--token=')) {
      args.token = arg.slice('--token='.length)
    } else if (arg.startsWith('--node=')) {
      args.node = arg.slice('--node='.length)
    }
  }
  return args
}

function projectRoot(): string {
  return resolve(import.meta.dir, '..')
}

function childEnv(input: {
  configDir: string
  node: string
  port: number
  group?: string
  token?: string
  capabilities: string
  roles: string
  noDns?: boolean
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.MATEBOT_ACTOR_ADDRESS
  delete env.OPENCC_NODE
  delete env.OPENCC_DNS_TOKEN
  env.CLAUDE_CONFIG_DIR = input.configDir
  env.OPENCC_NODE = input.node
  env.OPENCC_DNS_PORT = String(input.port)
  env.OPENCC_DNS_INTERVAL_MS = '1000'
  env.OPENCC_DNS_TTL_MS = '3000'
  env.OPENCC_SWARM_PUMP_INTERVAL_MS = '200'
  env.OPENCC_AGENT_CAPABILITIES = input.capabilities
  env.OPENCC_AGENT_ROLES = input.roles
  if (input.group) env.OPENCC_DNS_GROUP = input.group
  if (input.token) env.OPENCC_DNS_TOKEN = input.token
  if (input.noDns) env.OPENCC_DNS_DISABLED = '1'
  return env
}

function spawnDaemon(input: {
  configDir: string
  node: string
  port: number
  group?: string
  token?: string
  capabilities: string
  roles: string
  noDns?: boolean
}): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      process.execPath,
      'run',
      'src/entrypoints/cli.tsx',
      'swarm-daemon',
      '--verbose',
    ],
    {
      cwd: projectRoot(),
      env: childEnv(input),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
}

async function readCache(configDir: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(configDir, 'agents-dns', 'peers.json'), 'utf8'),
    )
    return parsed?.records ?? {}
  } catch {
    return {}
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<{ ok: boolean; elapsedMs: number }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return { ok: true, elapsedMs: Date.now() - start }
    await Bun.sleep(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - start }
}

async function stopChild(
  child: ReturnType<typeof Bun.spawn>,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
): Promise<void> {
  try {
    child.kill(signal)
  } catch {
    return
  }
  await Promise.race([child.exited, Bun.sleep(2_000)])
}

function printPeerTable(title: string, records: Record<string, any>): void {
  const rows = Object.values(records)
  out(`\n${title}`)
  if (rows.length === 0) {
    out('  (no peers)')
    return
  }
  out('  address                                      node         caps                 roles')
  for (const record of rows) {
    out(
      `  ${String(record.address).padEnd(44)} ${String(record.node).padEnd(12)} ${String(
        (record.capabilities ?? []).join(','),
      ).padEnd(20)} ${(record.roles ?? []).join(',')}`,
    )
  }
}

async function selfTest(args: Args): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'opencc-swarm-verify-'))
  const aDir = join(root, 'a')
  const bDir = join(root, 'b')
  const relayDir = join(root, 'relay')
  const port = args.port || 48000 + Math.floor(Math.random() * 500)
  const suffix = randomBytes(3).toString('hex')
  const nodeA = `verify-a-${suffix}`
  const nodeB = `verify-b-${suffix}`
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  let ok = true

  try {
    out(`self-test root: ${root}`)
    out(`multicast: ${args.group ?? '239.255.77.77'}:${port}`)
    out(`token: ${args.token ? 'signed' : 'unsigned (zero-config)'}`)

    const a = spawnDaemon({
      configDir: aDir,
      node: nodeA,
      port,
      group: args.group,
      token: args.token,
      capabilities: 'code,algorithm',
      roles: 'algorithm',
    })
    const b = spawnDaemon({
      configDir: bDir,
      node: nodeB,
      port,
      group: args.group,
      token: args.token,
      capabilities: 'test,security',
      roles: 'testing,security',
    })
    children.push(a, b)

    const discovery = await waitFor(async () => {
      const aCache = await readCache(aDir)
      const bCache = await readCache(bDir)
      return (
        Object.values(aCache).some((record: any) => record.node === nodeB) &&
        Object.values(bCache).some((record: any) => record.node === nodeA)
      )
    }, 12_000)
    out(
      `\ndiscovery: ${discovery.ok ? 'PASS' : 'FAIL'} (${discovery.elapsedMs} ms)`,
    )
    ok &&= discovery.ok
    printPeerTable('A sees', await readCache(aDir))
    printPeerTable('B sees', await readCache(bDir))

    // SIGKILL, not SIGTERM: a graceful stop sends agent-dns.bye and the peer is
    // removed immediately. TTL expiry is what happens when a host disappears.
    await stopChild(b, 'SIGKILL')
    children.splice(children.indexOf(b), 1)
    const expiry = await waitFor(async () => {
      const cache = await readCache(aDir)
      const now = Date.now()
      const peer = Object.values(cache).find(
        (record: any) => record.node === nodeB,
      ) as any
      return !peer || Date.parse(peer.updatedAt) + peer.ttlMs <= now
    }, 10_000)
    out(`\nttl expiry after B is killed: ${expiry.ok ? 'PASS' : 'FAIL'} (${expiry.elapsedMs} ms)`)
    ok &&= expiry.ok

    if (args.relay) {
      const relayed = await relayTest(relayDir, port, args, children)
      ok &&= relayed
    }

    return ok
  } finally {
    for (const child of children) await stopChild(child)
    await rm(root, { recursive: true, force: true })
  }
}

async function relayTest(
  configDir: string,
  port: number,
  args: Args,
  children: Array<ReturnType<typeof Bun.spawn>>,
): Promise<boolean> {
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.MATEBOT_ACTOR_ADDRESS

  const daemon = spawnDaemon({
    configDir,
    node: `verify-relay-${randomBytes(3).toString('hex')}`,
    port,
    group: args.group,
    token: args.token,
    capabilities: 'relay',
    roles: 'relay',
    noDns: true,
  })
  children.push(daemon)
  const ready = await waitFor(async () => {
    try {
      await readFile(join(configDir, 'agents-dns', 'daemon.pid'), 'utf8')
      return true
    } catch {
      return false
    }
  }, 5_000)
  if (!ready.ok) {
    out('\nrelay: FAIL (daemon did not start)')
    return false
  }

  const { localActorAddress } = await import('../src/actor/types.ts')
  const { LocalActorMailbox } = await import(
    '../src/actor/LocalActorMailbox.ts'
  )
  const { sendRouted, pumpOnce } = await import('../src/swarm/relay.ts')
  const { withState } = await import('../src/swarm/store.ts')

  const A = localActorAddress('default', 'verify-relay-a')
  const B = localActorAddress('default', 'verify-relay-b')
  const D = localActorAddress('default', 'verify-relay-d')
  const mailbox = new LocalActorMailbox()
  for (const address of [A, B, D]) {
    await mailbox.announce(address)
  }

  const edge = (
    from: string,
    to: string,
    alpha: number,
    beta: number,
    latencyEmaMs: number,
  ) => ({
    from,
    to,
    alpha,
    beta,
    attempts: 10,
    latencyEmaMs,
    costEma: 0,
    pheromone: alpha > beta ? 2 : 0,
    lastUsedAt: new Date().toISOString(),
  })
  await withState('default', state => {
    state.edges[`${A}\u0000${B}`] = edge(A, B, 9, 1, 50)
    state.edges[`${B}\u0000${D}`] = edge(B, D, 9, 1, 50)
    state.edges[`${A}\u0000${D}`] = edge(A, D, 1, 9, 3000)
  })

  process.env.MATEBOT_ACTOR_ADDRESS = A
  const first = await sendRouted({
    to: D,
    payload: { probe: 1 },
    kind: 'verify.probe',
    maxHops: 3,
  })
  process.env.MATEBOT_ACTOR_ADDRESS = B
  await pumpOnce(10, { address: B, team: 'default' })

  const arrivedFirst = await waitFor(
    async () =>
      (await mailbox.peek(D)).some(
        envelope =>
          (envelope.payload as { probe?: number } | undefined)?.probe === 1,
      ),
    3_000,
  )

  // Second probe is left to the resident daemon's pumpAllLocal.
  process.env.MATEBOT_ACTOR_ADDRESS = A
  const second = await sendRouted({
    to: D,
    payload: { probe: 2 },
    kind: 'verify.probe',
    maxHops: 3,
  })
  const arrivedSecond = await waitFor(
    async () =>
      (await mailbox.peek(D)).some(
        envelope =>
          (envelope.payload as { probe?: number } | undefined)?.probe === 2,
      ),
    5_000,
  )

  const path = first.path.join(' -> ')
  const relayPass =
    first.mode === 'relay' &&
    first.path.length === 3 &&
    arrivedFirst.ok &&
    second.mode === 'relay' &&
    arrivedSecond.ok
  out(`\nrelay: ${relayPass ? 'PASS' : 'FAIL'} (${path})`)
  out(`  first (manual pump): ${arrivedFirst.ok ? 'delivered' : 'missing'}`)
  out(`  second (daemon pump): ${arrivedSecond.ok ? 'delivered' : 'missing'}`)
  return relayPass
}

async function joinTest(args: Args): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'opencc-swarm-join-'))
  const configDir = join(root, 'node')
  const port = args.port || 47777
  const node = args.node || `join-${randomBytes(3).toString('hex')}`
  const child = spawnDaemon({
    configDir,
    node,
    port,
    group: args.group,
    token: args.token,
    capabilities: 'code',
    roles: 'generalist',
  })

  try {
    out(`joining LAN as ${node}; multicast ${args.group ?? '239.255.77.77'}:${port}`)
    out(`token: ${args.token ? 'signed' : 'unsigned (zero-config)'}`)
    out(`waiting ${Math.round(args.durationMs / 1000)}s for beacons...`)
    const deadline = Date.now() + args.durationMs
    let lastCount = 0
    while (Date.now() < deadline) {
      const records = await readCache(configDir)
      const count = Object.keys(records).length
      if (count !== lastCount) {
        lastCount = count
        out(`  peers: ${count}`)
      }
      await Bun.sleep(500)
    }
    const records = await readCache(configDir)
    printPeerTable('discovered peers', records)
    if (Object.keys(records).length === 0) {
      out('\nNo peers. Check: same group/port, UDP 47777 open, AP client isolation off,')
      out('and run this script on the other machine at the same time.')
      return false
    }
    return true
  } finally {
    await stopChild(child)
    await rm(root, { recursive: true, force: true })
  }
}

const args = parseArgs(process.argv.slice(2))
const ok = args.join ? await joinTest(args) : await selfTest(args)
out(`\nresult: ${ok ? 'PASS' : 'FAIL'}`)
process.exitCode = ok ? 0 : 1
