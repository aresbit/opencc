import { spawn } from 'child_process'
import { closeSync, mkdirSync, openSync } from 'fs'
import { connect } from 'net'
import { join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { LocalActorMailbox } from '../LocalActorMailbox.js'
import { getLocalNodeName } from '../types.js'
import { DEFAULT_ACTORD_PORT, loadPeerTable, startActorNode } from './ActorNode.js'

function readListen(): { host: string; port: number } {
  const [hostname, portText] = (process.env.OPENCC_ACTORD_LISTEN?.trim() ||
    `127.0.0.1:${DEFAULT_ACTORD_PORT}`).split(/:(?=[^:]*$)/)
  return {
    host: (hostname ?? '').replace(/^\[|\]$/g, ''),
    port: Number.parseInt(portText ?? '', 10) || DEFAULT_ACTORD_PORT,
  }
}

function envDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'off', 'no'].includes(value?.trim().toLowerCase() ?? '')
}

/** TCP probe: is something already accepting on the actord address? */
function isListening(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  const target =
    host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return new Promise(resolveProbe => {
    const socket = connect({ host: target, port })
    let settled = false
    const done = (up: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(up)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * MateBot hosts call this at startup so the host's actor door exists without a
 * second manual command. actord is one per host: if something is already
 * accepting on the address this is a no-op, and concurrent sessions race
 * harmlessly because losing the bind is treated as success by `runActord`.
 *
 * Detached on purpose — it outlives the session, exactly like a manually
 * started `opencc actord`. Logs go to ~/.claude/debug/actord.log.
 *
 * Opt out with OPENCC_ACTORD=0.
 */
export function ensureActordRunning(entry = process.argv[1]): void {
  if (envDisabled(process.env.OPENCC_ACTORD)) return
  if (!entry) return
  const { host, port } = readListen()
  void isListening(host, port).then(up => {
    if (up) return
    try {
      const logDir = join(getClaudeConfigHomeDir(), 'debug')
      mkdirSync(logDir, { recursive: true })
      const fd = openSync(join(logDir, 'actord.log'), 'a')
      const child = spawn(process.execPath, [resolve(entry), 'actord'], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: process.env,
      })
      child.unref()
      closeSync(fd)
    } catch {
      // Best effort: a failed autostart must never block a session.
    }
  })
}

/**
 * `opencc actord` — this host's door to the actor cluster.
 *
 *   OPENCC_NODE            node name (default: hostname)
 *   OPENCC_ACTORD_LISTEN   host:port to accept peers (default 127.0.0.1:7781;
 *                          use the tailnet address to accept other hosts)
 *   OPENCC_ACTORD_TOKEN    shared cluster secret (required beyond loopback)
 *   OPENCC_ACTORD_PEERS    a=ws://host:7781,b=… (merged over nodes.json)
 *   OPENCC_ACTORD=0        opt out of autostart from `opencc --matebot`
 *
 * Peers to dial live in ~/.claude/actors/nodes.json: {"pc": "ws://100.x.y.z:7781"}.
 * Inbound mail is written into ~/.claude/actors — the directory every session
 * already reads — so nothing else on this host needs configuring.
 *
 * Starting twice is not an error: when the listen address already has a
 * server, this exits 0 ("already served"), so autostart stays idempotent.
 */
export async function runActord(): Promise<void> {
  const { host: hostname, port } = readListen()
  const root = join(getClaudeConfigHomeDir(), 'actors')
  const node = getLocalNodeName()
  const peers = loadPeerTable(root)

  let handle
  try {
    handle = startActorNode({
      node,
      mailbox: new LocalActorMailbox(root, { node }),
      listen: { hostname, port },
      peers,
      token: process.env.OPENCC_ACTORD_TOKEN?.trim() || undefined,
      log: line => console.log(`${new Date().toISOString()} ${line}`),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (
      code === 'EADDRINUSE' ||
      /EADDRINUSE|address already in use|is port \d+ in use/i.test(message)
    ) {
      console.log(`actord: ${hostname}:${port} is already served; nothing to do`)
      process.exit(0)
    }
    console.error(message)
    process.exit(1)
  }

  console.log(`actord: node "${handle.node}" listening at ${handle.url}`)
  console.log(`actord: mailbox ${root}`)
  console.log(
    Object.keys(peers).length > 0
      ? `actord: dialing ${Object.entries(peers).map(([n, u]) => `${n}=${u}`).join(', ')}`
      : `actord: no peers configured (${join(root, 'nodes.json')}); accepting only`,
  )
  console.log(`actord: address sessions here as actor://<team>/<name>@${handle.node}`)

  const shutdown = async () => {
    await handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  // Keep the process alive; the server and dial timers own the event loop.
  await new Promise(() => {})
}
