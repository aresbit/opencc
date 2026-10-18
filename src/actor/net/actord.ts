import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { LocalActorMailbox } from '../LocalActorMailbox.js'
import { getLocalNodeName } from '../types.js'
import { DEFAULT_ACTORD_PORT, loadPeerTable, startActorNode } from './ActorNode.js'

/**
 * `opencc actord` — this host's door to the actor cluster.
 *
 *   OPENCC_NODE            node name (default: hostname)
 *   OPENCC_ACTORD_LISTEN   host:port to accept peers (default 127.0.0.1:7781;
 *                          use the tailnet address to accept other hosts)
 *   OPENCC_ACTORD_TOKEN    shared cluster secret (required beyond loopback)
 *   OPENCC_ACTORD_PEERS    a=ws://host:7781,b=… (merged over nodes.json)
 *
 * Peers to dial live in ~/.claude/actors/nodes.json: {"pc": "ws://100.x.y.z:7781"}.
 * Inbound mail is written into ~/.claude/actors — the directory every session
 * already reads — so nothing else on this host needs configuring.
 */
export async function runActord(): Promise<void> {
  const [hostname, portText] = (process.env.OPENCC_ACTORD_LISTEN?.trim() ||
    `127.0.0.1:${DEFAULT_ACTORD_PORT}`).split(/:(?=[^:]*$)/)
  const port = Number.parseInt(portText ?? '', 10) || DEFAULT_ACTORD_PORT
  const root = join(getClaudeConfigHomeDir(), 'actors')
  const node = getLocalNodeName()
  const peers = loadPeerTable(root)

  let handle
  try {
    handle = startActorNode({
      node,
      mailbox: new LocalActorMailbox(root, { node }),
      listen: { hostname: hostname!.replace(/^\[|\]$/g, ''), port },
      peers,
      token: process.env.OPENCC_ACTORD_TOKEN?.trim() || undefined,
      log: line => console.log(`${new Date().toISOString()} ${line}`),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
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
