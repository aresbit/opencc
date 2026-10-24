/**
 * `opencc swarm-daemon` — resident pump + Agent-DNS beacon loop.
 *
 * Why a daemon: relay mail for a session that is busy (or between turns) would
 * otherwise sit in its mailbox until the model happens to call `pump`. The
 * daemon drains every live local actor's relay queue and keeps the LAN
 * discovery cache warm, which is what turns SwarmNet from "callable routing"
 * into an always-on network.
 *
 * It does not read or act on normal mail. pumpOnce peeks, filters
 * kind=swarm.relay, and claims only what it forwarded.
 *
 * The same loop can run embedded in a MateBot host:
 * startEmbeddedSwarmDaemon() keeps the event loop in the session process and
 * skips the PID lock if a standalone daemon already owns it.
 */

import { readFileSync, unlinkSync } from 'fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getCurrentActorAddress,
  getServedActorAddresses,
} from '../actor/currentActor.js'
import { parseActorAddress, getLocalNodeName } from '../actor/types.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import {
  announceLocalRecord,
  getDnsConfig,
  getDnsRoot,
  listDnsRecords,
  mergeBeaconRecords,
  pruneDnsCache,
  purgeNodeRecords,
  readLocalRecords,
  type AgentDnsRecord,
  type AgentStatus,
  type DnsConfig,
} from './dns.js'
import {
  openDnsTransport,
  type DnsPacket,
  type DnsTransport,
} from './dnsTransport.js'
import { pumpAllLocal } from './relay.js'
import { pickSwarmInterface } from './network.js'
import {
  getSwarmProfilePath,
  loadSwarmProfileSync,
  writeDefaultSwarmProfile,
} from './profile.js'
import { getSwarmTeam } from './store.js'

export type DaemonOptions = {
  once: boolean
  verbose: boolean
  beaconIntervalMs: number
  pumpIntervalMs: number
  pruneIntervalMs: number
  pumpLimit: number
  config: DnsConfig
}

export type DaemonHandle = {
  stop: () => Promise<void>
}

function parseArgs(argv: string[]): DaemonOptions {
  const config = getDnsConfig()
  const profile = loadSwarmProfileSync()
  let once = false
  let verbose = false
  let beaconIntervalMs = config.intervalMs
  let pumpIntervalMs =
    Number.parseInt(process.env.OPENCC_SWARM_PUMP_INTERVAL_MS ?? '', 10) ||
    profile.pumpIntervalMs ||
    1_000
  let pruneIntervalMs =
    Number.parseInt(process.env.OPENCC_SWARM_PRUNE_INTERVAL_MS ?? '', 10) ||
    profile.pruneIntervalMs ||
    30_000
  let pumpLimit =
    Number.parseInt(process.env.OPENCC_SWARM_PUMP_LIMIT ?? '', 10) ||
    profile.pumpLimit ||
    20

  for (const arg of argv) {
    if (arg === '--once') once = true
    else if (arg === '--verbose' || arg === '-v') verbose = true
    else if (arg.startsWith('--interval=')) {
      beaconIntervalMs =
        Number.parseInt(arg.slice('--interval='.length), 10) || beaconIntervalMs
    } else if (arg.startsWith('--pump-interval=')) {
      pumpIntervalMs =
        Number.parseInt(arg.slice('--pump-interval='.length), 10) || pumpIntervalMs
    } else if (arg.startsWith('--pump-limit=')) {
      pumpLimit =
        Number.parseInt(arg.slice('--pump-limit='.length), 10) || pumpLimit
    } else if (arg === '--no-dns') {
      config.disabled = true
    }
  }
  return {
    once,
    verbose,
    beaconIntervalMs,
    pumpIntervalMs,
    pruneIntervalMs,
    pumpLimit,
    config,
  }
}

function logLine(
  stdout: boolean,
  verbose: boolean,
  line: string,
): void {
  const text = `${new Date().toISOString()} ${line}`
  if (stdout) process.stdout.write(`swarm-daemon: ${line}\n`)
  if (!verbose) return
  const path = join(getClaudeConfigHomeDir(), 'debug', 'swarm-daemon.log')
  void mkdir(join(getClaudeConfigHomeDir(), 'debug'), { recursive: true })
    .then(() => appendFile(path, `${text}\n`))
    .catch(() => {})
}

function parseCaps(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 32)
}

function envStatus(): AgentStatus | undefined {
  const value = process.env.OPENCC_AGENT_STATUS?.trim()
  return value === 'idle' || value === 'busy' || value === 'offline'
    ? value
    : undefined
}

function envDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off', 'no'].includes(value?.trim().toLowerCase() ?? '')
}

/**
 * Refresh the records this host is responsible for. Existing records keep the
 * capabilities/roles a session announced via SwarmNetTool; only liveness and
 * sequence are bumped. Without this, a session's own `announce` would expire
 * while the daemon kept advertising stale capabilities.
 */
async function refreshServedRecords(): Promise<AgentDnsRecord[]> {
  const existing = await readLocalRecords()
  const byAddress = new Map(existing.map(record => [record.address, record]))
  const served = new Set(getServedActorAddresses())
  const profile = loadSwarmProfileSync()

  for (const address of served) {
    const previous = byAddress.get(address)
    let parsed
    try {
      parsed = parseActorAddress(address)
    } catch {
      continue
    }
    const envLoad = Number.parseInt(process.env.OPENCC_AGENT_LOAD ?? '', 10)
    await announceLocalRecord({
      address,
      team: parsed.team,
      name: parsed.name,
      capabilities:
        parseCaps(process.env.OPENCC_AGENT_CAPABILITIES) ??
        profile.capabilities ??
        previous?.capabilities ??
        ['code'],
      roles:
        parseCaps(process.env.OPENCC_AGENT_ROLES) ??
        profile.roles ??
        previous?.roles ??
        ['generalist'],
      load:
        Number.isFinite(envLoad) && envLoad >= 0
          ? envLoad
          : (profile.load ?? previous?.load ?? 0),
      status: envStatus() ?? profile.status ?? previous?.status ?? 'idle',
    })
  }
  return readLocalRecords()
}

function daemonLockPath(): string {
  return join(getDnsRoot(), 'daemon.pid')
}

function releaseLockSync(): void {
  try {
    const current = JSON.parse(readFileSync(daemonLockPath(), 'utf8')) as {
      pid?: number
    }
    if (current?.pid === process.pid) unlinkSync(daemonLockPath())
  } catch {
    // Already gone.
  }
}

/**
 * `allowRunning` is for embedded mode: a standalone daemon already serving the
 * host is a success, not an error. Standing alone still refuses to start twice.
 *
 * Either way the holder of the lock is reported through `mode`, so a standalone
 * start can tell "another standalone owns the host" apart from "a MateBot
 * session already embeds the daemon".
 */
async function acquireDaemonLock(
  allowRunning: boolean,
  mode: 'embedded' | 'standalone',
): Promise<(() => Promise<void>) | null> {
  const path = daemonLockPath()
  await mkdir(getDnsRoot(), { recursive: true })
  const payload = jsonStringify({
    pid: process.pid,
    mode,
    node: process.env.OPENCC_NODE || undefined,
    startedAt: new Date().toISOString(),
  })

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, payload, { flag: 'wx' })
      return async () => {
        try {
          const current = jsonParse(await readFile(path, 'utf8')) as {
            pid?: number
          }
          if (current?.pid === process.pid) await rm(path)
        } catch {
          // Already gone.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const current = jsonParse(await readFile(path, 'utf8')) as {
          pid?: number
          mode?: string
        }
        if (current?.pid && current.pid !== process.pid) {
          process.kill(current.pid, 0)
          if (allowRunning) return null
          throw new Error(
            `swarm-daemon already running (pid ${current.pid}${
              current.mode ? `, ${current.mode}` : ''
            }); stop it or remove ${path}`,
          )
        }
      } catch (probeError) {
        if (
          probeError instanceof Error &&
          probeError.message.startsWith('swarm-daemon already running')
        ) {
          throw probeError
        }
        // Stale pid or unreadable file: take it over.
        await rm(path).catch(() => {})
      }
    }
  }
  if (allowRunning) return null
  throw new Error(`could not acquire ${path}`)
}

async function startDaemon(
  options: DaemonOptions,
  settings: { embedded: boolean; stdout: boolean },
): Promise<DaemonHandle | null> {
  const releaseLock = await acquireDaemonLock(
    settings.embedded,
    settings.embedded ? 'embedded' : 'standalone',
  )
  if (!releaseLock) return null

  const log = (line: string) => logLine(settings.stdout, options.verbose, line)
  const config = options.config
  log(
    `start pid=${process.pid} self=${getCurrentActorAddress()} dns=${
      config.disabled ? 'off' : `${config.group}:${config.port}`
    } pump=${options.pumpIntervalMs}ms beacon=${options.beaconIntervalMs}ms`,
  )

  let stopped = false
  const timers: Array<ReturnType<typeof setInterval>> = []
  let transport: DnsTransport | undefined
  const repliedAt = new Map<string, number>()

  const handlePacket = async (packet: DnsPacket): Promise<void> => {
    const { beacon, from } = packet
    if (beacon.kind === 'agent-dns.query') {
      const records = await readLocalRecords()
      await transport?.announce('agent-dns.beacon', records, {
        address: from.address,
        port: from.port,
      })
      return
    }
    if (beacon.kind === 'agent-dns.bye') {
      const removed = await purgeNodeRecords(beacon.node)
      if (removed > 0) log(`dns bye ${beacon.node}: removed ${removed}`)
      return
    }
    const result = await mergeBeaconRecords(beacon)
    if (result.accepted > 0) {
      log(
        `dns ${beacon.node}: accepted=${result.accepted} rejected=${result.rejected}`,
      )
    }
    // One-sided bootstrap: if only A knows B's address, B sees A's beacon and
    // answers unicast so A learns B too. Rate-limited; multicast-only setups
    // never reply, which avoids N² chatter on a flat LAN.
    if (config.bootstrap.length > 0) {
      const now = Date.now()
      const last = repliedAt.get(from.address) ?? 0
      if (now - last > 60_000) {
        repliedAt.set(from.address, now)
        const records = await readLocalRecords()
        await transport?.announce('agent-dns.beacon', records, {
          address: from.address,
          port: from.port,
        })
      }
    }
  }

  try {
    transport = await openDnsTransport(
      config,
      packet => {
        void handlePacket(packet).catch(error => {
          log(
            `dns packet failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        })
      },
      log,
      { unref: settings.embedded },
    )
  } catch (error) {
    // A port conflict must not take down the session that embedded us, and the
    // relay pump is still useful without discovery.
    log(
      `dns transport unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    transport = {
      announce: async () => {},
      close: async () => {},
      stats: () => ({
        sent: 0,
        received: 0,
        dropped: 0,
        sendErrors: 0,
        broadcast: false,
      }),
    }
  }

  const beaconTick = async (
    kind: 'agent-dns.beacon' | 'agent-dns.bye' = 'agent-dns.beacon',
  ) => {
    const records = await refreshServedRecords()
    await transport?.announce(kind, records)
    return records
  }

  const pumpTick = async () => {
    const results = await pumpAllLocal(options.pumpLimit, log)
    const forwarded = results.reduce((sum, item) => sum + item.forwarded, 0)
    const delivered = results.reduce((sum, item) => sum + item.delivered, 0)
    const dead = results.reduce((sum, item) => sum + item.dead, 0)
    if (forwarded + delivered + dead > 0) {
      log(
        `pump actors=${results.length} forwarded=${forwarded} delivered=${delivered} dead=${dead}`,
      )
    }
    return results
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const timer of timers) clearInterval(timer)
    try {
      const records = await readLocalRecords()
      await transport?.announce('agent-dns.bye', records)
    } catch {
      // Best effort: a goodbye is not a correctness requirement.
    }
    await transport?.close()
    const finalStats = transport?.stats()
    if (finalStats) {
      log(
        `stats tx=${finalStats.sent} rx=${finalStats.received} drop=${finalStats.dropped} sendErrors=${finalStats.sendErrors}`,
      )
    }
    await releaseLock()
    log('stopped')
  }

  if (options.once) {
    const records = await beaconTick()
    await pumpTick()
    await pruneDnsCache()
    log(`once: announced=${records.length}`)
    await stop()
    return { stop }
  }

  timers.push(
    setInterval(() => {
      void beaconTick().catch(error => log(`beacon failed: ${String(error)}`))
    }, options.beaconIntervalMs),
    setInterval(() => {
      void pumpTick().catch(error => log(`pump failed: ${String(error)}`))
    }, options.pumpIntervalMs),
    setInterval(() => {
      void pruneDnsCache()
        .then(removed => {
          if (removed > 0) log(`dns prune removed=${removed}`)
        })
        .catch(error => log(`prune failed: ${String(error)}`))
    }, options.pruneIntervalMs),
  )
  // Embedded sessions must still be able to exit after a one-shot turn;
  // standalone ownership of the event loop depends on these handles.
  if (settings.embedded) {
    for (const timer of timers) {
      ;(timer as unknown as { unref?: () => void }).unref?.()
    }
  }

  // Initial tick so the first peer does not wait a full interval.
  await beaconTick().catch(error => log(`initial beacon failed: ${String(error)}`))
  await pumpTick().catch(error => log(`initial pump failed: ${String(error)}`))
  log(
    `ready team=${getSwarmTeam()} served=${getServedActorAddresses().length} discovered=${
      (await listDnsRecords({ liveOnly: true })).length
    } dns iface=${transport.stats().interface ?? 'default'} signed=${
      config.token ? 'yes' : 'no'
    } tx=${transport.stats().sent} rx=${transport.stats().received} drop=${
      transport.stats().dropped
    }`,
  )
  return { stop }
}

export async function runSwarmDaemon(
  argv = process.argv.slice(2),
): Promise<void> {
  const options = parseArgs(argv)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`Usage: opencc swarm-daemon [--once] [--no-dns] [--verbose]
  --init                 write ~/.claude/swarm.json with editable defaults
  --show                 print the effective zero-config settings and exit
  --interval=<ms>        beacon interval (default 5000)
  --pump-interval=<ms>   relay drain interval (default 1000)
  --pump-limit=<n>       envelopes per actor per tick (default 20)
Everything is optional: node name, DNS port/group and capabilities have
working defaults. Env overrides swarm.json; swarm.json overrides defaults.
Env: OPENCC_DNS_GROUP/PORT/TOKEN, OPENCC_AGENT_CAPABILITIES, OPENCC_AGENT_ROLES
`)
    return
  }
  if (argv.includes('--init')) {
    const result = await writeDefaultSwarmProfile()
    process.stdout.write(
      `swarm-daemon: profile ${result.created ? 'created' : 'already exists'} at ${result.path}\n`,
    )
    process.stdout.write(`${jsonStringify(result.profile, null, 2)}\n`)
    return
  }
  if (argv.includes('--show')) {
    const config = getDnsConfig()
    const profile = loadSwarmProfileSync()
    process.stdout.write(
      `${jsonStringify(
        {
          node: getLocalNodeName(),
          profile: getSwarmProfilePath(),
          dns: {
            group: config.group,
            port: config.port,
            intervalMs: config.intervalMs,
            ttlMs: config.ttlMs,
            signed: Boolean(config.token),
            disabled: config.disabled,
            interface:
              pickSwarmInterface(config.interface)?.address ??
              config.interface ??
              'default',
            broadcast: config.broadcast,
            bootstrap: config.bootstrap,
          },
          capabilities:
            parseCaps(process.env.OPENCC_AGENT_CAPABILITIES) ??
            profile.capabilities ??
            ['code'],
          roles:
            parseCaps(process.env.OPENCC_AGENT_ROLES) ??
            profile.roles ??
            ['generalist'],
          pumpIntervalMs:
            Number.parseInt(process.env.OPENCC_SWARM_PUMP_INTERVAL_MS ?? '', 10) ||
            profile.pumpIntervalMs ||
            1_000,
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  let handle: DaemonHandle | null
  try {
    handle = await startDaemon(options, { embedded: false, stdout: true })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('swarm-daemon already running')
    ) {
      // The host is already served — by another standalone daemon or by the
      // embedded daemon of a running MateBot session. That satisfies this
      // command's goal, so report it instead of failing the shell.
      process.stdout.write(
        `swarm-daemon: ${error.message}\n` +
          `swarm-daemon: already serving this host; nothing to do\n`,
      )
      return
    }
    throw error
  }
  if (!handle) throw new Error('swarm-daemon could not start')

  const shutdown = async () => {
    await handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  await new Promise(() => {})
}

let embeddedHandle: DaemonHandle | null = null

/**
 * Start the daemon inside the current process. Used by MateBot hosts so that
 * `opencc --matebot` gets relay pumping and LAN discovery without a second
 * command or a child process.
 *
 * Opt out with OPENCC_SWARM_DAEMON=0. If a standalone `opencc swarm-daemon`
 * already owns the host, this is a no-op: the standalone process is strictly
 * better (it survives session restarts).
 */
export async function startEmbeddedSwarmDaemon(): Promise<DaemonHandle | null> {
  if (embeddedHandle) return embeddedHandle
  if (envDisabled(process.env.OPENCC_SWARM_DAEMON)) return null

  const options = parseArgs([])
  options.verbose = true // embedded logs go to debug/swarm-daemon.log only
  options.config.intervalMs = options.beaconIntervalMs

  const handle = await startDaemon(options, {
    embedded: true,
    stdout: false,
  })
  if (!handle) return null

  embeddedHandle = handle
  process.once('exit', releaseLockSync)
  return handle
}

/** Test/teardown seam. */
export async function stopEmbeddedSwarmDaemon(): Promise<void> {
  if (!embeddedHandle) return
  const handle = embeddedHandle
  embeddedHandle = null
  await handle.stop()
}
