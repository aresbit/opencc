import { createHmac, timingSafeEqual } from 'crypto'
import { type FSWatcher, mkdirSync, readFileSync, watch } from 'fs'
import { join } from 'path'
import { LocalActorMailbox } from '../LocalActorMailbox.js'
import {
  ACTOR_PROTOCOL_VERSION,
  type ActorAddress,
  type ActorEnvelope,
  getLocalNodeName,
  nodeActorAddress,
  normalizeNodeName,
  parseActorAddress,
} from '../types.js'

/**
 * actor-net v1 — the smallest protocol that carries the local actor mailbox
 * between hosts.
 *
 * A session never talks to the network. It sends to `name@node` and the
 * mailbox appends to .net/outbox/<node>.json; it reads its inbox from
 * ~/.claude/actors as always. One actord per host owns the port, drains the
 * outbox over a persistent WebSocket per peer, and writes what arrives straight
 * into the same mailbox directory the sessions read.
 *
 * Five frames, JSON, one per WebSocket message:
 *
 *   hi   {node, v, ts, mac, live}   both sides, first; HMAC over node+ts
 *   tx   {env}                      an envelope for this host
 *   ok   {id}                       durably written here; sender drops it
 *   rcpt {to, id, by, at, status}   consumed (or given up on) here
 *   live {live}                     addresses served here; ≤30s apart
 *
 * Guarantees: at-least-once on the wire (outbox resends until `ok`), dedupe by
 * envelope id at the receiving mailbox, at-most-once claim by the session, and
 * the consumption receipt lands in the sender's own sidecar — so
 * awaitDelivery/reliableSend work unchanged across hosts. Order is per peer
 * outbox order, best effort; nothing is global.
 *
 * The one rule with teeth is at the boundary: outbound `from`/`replyTo` get
 * `@thisNode`, inbound `to` must name this node and inbound `from` must name
 * the authenticated peer. A peer cannot speak for a third host.
 */

export const ACTOR_NET_VERSION = 1
export const ACTOR_NET_PATH = '/actor'
export const DEFAULT_ACTORD_PORT = 7781

/** Unconfirmed envelopes are resent this often. */
const DEFAULT_RESEND_MS = 5_000
/**
 * Give up on an envelope after this long.
 *
 * Must stay under the receiving mailbox's dedupe window (CLAIMED_RETENTION_MS,
 * 5 min): a resend that arrives after the receiver forgot the id would be
 * delivered twice. Past this the sender gets a dead receipt instead.
 */
const DEFAULT_RETRY_WINDOW_MS = 4 * 60 * 1000
const DEFAULT_TICK_MS = 500
const DEFAULT_PRESENCE_MS = 5_000
/** Re-announce even when nothing changed, well inside PRESENCE_STALE_MS (90s). */
const PRESENCE_HEARTBEAT_MS = 30_000
/** Accepted clock skew for the `hi` MAC. */
const HI_SKEW_MS = 120_000
const MAX_REDIAL_MS = 30_000

type HiFrame = { t: 'hi'; v: number; node: string; ts: number; mac?: string; live?: unknown }
type TxFrame = { t: 'tx'; env: ActorEnvelope }
type OkFrame = { t: 'ok'; id: string }
type RcptFrame = {
  t: 'rcpt'
  to: string
  id: string
  by: string
  at: string
  status?: 'acked' | 'dead'
  reason?: string
}
type LiveFrame = { t: 'live'; live: unknown }
type Frame = HiFrame | TxFrame | OkFrame | RcptFrame | LiveFrame

export type ActorNodeOptions = {
  node?: string
  mailbox?: LocalActorMailbox
  /** Where to accept peers. false = dial out only. */
  listen?: { hostname: string; port: number } | false
  /** node name → ws URL. Defaults to <actors>/nodes.json. */
  peers?: Record<string, string>
  /** Shared cluster secret. Required to listen beyond loopback. */
  token?: string
  tickMs?: number
  resendMs?: number
  retryWindowMs?: number
  presenceMs?: number
  log?: (line: string) => void
}

export type ActorNodeHandle = {
  node: string
  /** Where peers reach this node, when listening. */
  url?: string
  connectedPeers(): string[]
  stop(): Promise<void>
}

type Link = {
  send(text: string): void
  close(code?: number, reason?: string): void
  peer?: string
  ready: boolean
  /** envelope id → last time it was put on this link */
  inflight: Map<string, number>
}

function isLoopback(hostname: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(hostname)
}

export function hiMac(token: string, node: string, ts: number): string {
  return createHmac('sha256', token)
    .update(`actor-net/${ACTOR_NET_VERSION}|${node}|${ts}`)
    .digest('hex')
}

function macMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Peer table: <actors>/nodes.json, then OPENCC_ACTORD_PEERS=a=ws://…,b=ws://… */
export function loadPeerTable(root: string): Record<string, string> {
  const peers: Record<string, string> = {}
  try {
    const raw = JSON.parse(readFileSync(join(root, 'nodes.json'), 'utf8'))
    if (raw && typeof raw === 'object') {
      for (const [node, url] of Object.entries(raw)) {
        if (typeof url === 'string') peers[normalizeNodeName(node)] = url
      }
    }
  } catch {
    // No table yet: this node only accepts.
  }
  for (const pair of (process.env.OPENCC_ACTORD_PEERS ?? '').split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) peers[normalizeNodeName(pair.slice(0, eq))] = pair.slice(eq + 1).trim()
  }
  return peers
}

/** `ws://100.64.0.2:7781` → `ws://100.64.0.2:7781/actor`. */
export function peerUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = ACTOR_NET_PATH
  return parsed.toString()
}

export function startActorNode(options: ActorNodeOptions = {}): ActorNodeHandle {
  const self = normalizeNodeName(options.node ?? getLocalNodeName())
  const mailbox = options.mailbox ?? new LocalActorMailbox(undefined, { node: self })
  const token = options.token || undefined
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS
  const resendMs = options.resendMs ?? DEFAULT_RESEND_MS
  const retryWindowMs = options.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS
  const presenceMs = options.presenceMs ?? DEFAULT_PRESENCE_MS
  const log = options.log ?? (() => {})
  const listen = options.listen ?? false

  if (listen && !isLoopback(listen.hostname) && !token) {
    // Every inbound envelope is injected into an agent session that can run
    // shell. Listening beyond loopback without a secret is not a default.
    throw new Error(
      `actord refuses to listen on ${listen.hostname} without a token (set OPENCC_ACTORD_TOKEN).`,
    )
  }

  const parse = (value: string): ActorAddress =>
    parseActorAddress(value, undefined, self)

  /** Every ready link, newest last, per peer node. */
  const links = new Map<string, Link[]>()
  let stopped = false
  let lastLive = ''
  let lastLiveAt = 0
  let draining = false

  const readyLink = (node: string): Link | undefined =>
    links.get(node)?.filter(link => link.ready).at(-1)

  const sendFrame = (link: Link, frame: Frame): void => {
    link.send(JSON.stringify(frame))
  }

  /** Local addresses this host serves, qualified with this node. */
  const localLive = async (): Promise<string[]> =>
    (await mailbox.list())
      .filter(entry => entry.live)
      .map(entry => parse(entry.address))
      .filter(address => address.transport === 'local')
      .map(address => nodeActorAddress(address.team, address.name, self))
      .sort()

  const sendHi = async (link: Link): Promise<void> => {
    const ts = Date.now()
    sendFrame(link, {
      t: 'hi',
      v: ACTOR_NET_VERSION,
      node: self,
      ts,
      ...(token ? { mac: hiMac(token, self, ts) } : {}),
      live: await localLive(),
    })
  }

  /** Only addresses on that peer's own node; a peer cannot advertise others. */
  const peerLive = (node: string, value: unknown): string[] =>
    (Array.isArray(value) ? value : [])
      .filter((item): item is string => typeof item === 'string')
      .filter(item => {
        try {
          const address = parse(item)
          return address.transport === 'node' && address.node === node
        } catch {
          return false
        }
      })

  const markPeer = async (node: string, connected: boolean, live: string[]) => {
    await mailbox.writePeerState({
      node,
      connected,
      live,
      updatedAt: new Date().toISOString(),
    })
  }

  /** A local address, qualified with this node; anything else unchanged. */
  const qualify = (value: string): string => {
    try {
      const address = parse(value)
      return address.transport === 'local'
        ? nodeActorAddress(address.team, address.name, self)
        : value
    } catch {
      return value
    }
  }

  /** `from`/`replyTo` leave this host qualified with it, so replies come back. */
  const stamp = (envelope: ActorEnvelope): ActorEnvelope => ({
    ...envelope,
    from: qualify(envelope.from),
    ...(envelope.replyTo ? { replyTo: qualify(envelope.replyTo) } : {}),
  })

  const reject = (link: Link, envelope: ActorEnvelope, reason: string): void => {
    log(`[actord] rejected ${envelope.id} from ${link.peer}: ${reason}`)
    // ok first, so the sender stops resending something that will never land.
    sendFrame(link, { t: 'ok', id: envelope.id })
    sendFrame(link, {
      t: 'rcpt',
      to: envelope.from,
      id: envelope.id,
      by: `node:${self}`,
      at: new Date().toISOString(),
      status: 'dead',
      reason,
    })
  }

  const inbound = async (link: Link, envelope: ActorEnvelope): Promise<void> => {
    if (
      !envelope ||
      envelope.v !== ACTOR_PROTOCOL_VERSION ||
      typeof envelope.id !== 'string' ||
      typeof envelope.from !== 'string' ||
      typeof envelope.to !== 'string' ||
      typeof envelope.kind !== 'string' ||
      typeof envelope.sentAt !== 'string'
    ) {
      log(`[actord] malformed envelope from ${link.peer}`)
      return
    }
    let to: ActorAddress
    let from: ActorAddress
    try {
      to = parse(envelope.to)
      from = parse(envelope.from)
    } catch (error) {
      reject(link, envelope, `bad address: ${error}`)
      return
    }
    if (to.transport !== 'local') {
      reject(link, envelope, `not addressed to node ${self}`)
      return
    }
    if (from.transport !== 'node' || from.node !== link.peer) {
      reject(link, envelope, `sender must be on the authenticated peer node ${link.peer}`)
      return
    }
    await mailbox.send({
      ...envelope,
      to: to.canonical,
      metadata: { ...(envelope.metadata ?? {}), via: link.peer },
    })
    sendFrame(link, { t: 'ok', id: envelope.id })
  }

  const onReady = async (link: Link, hi: HiFrame): Promise<void> => {
    const node = normalizeNodeName(String(hi.node ?? ''))
    if (hi.v !== ACTOR_NET_VERSION || !node) {
      link.close(4002, 'bad hello')
      return
    }
    if (node === self) {
      link.close(4003, `peer claims this node's name (${self})`)
      return
    }
    if (token) {
      const ts = Number(hi.ts)
      if (
        !Number.isFinite(ts) ||
        Math.abs(Date.now() - ts) > HI_SKEW_MS ||
        !macMatches(hiMac(token, node, ts), hi.mac)
      ) {
        log(`[actord] auth failed for ${node}`)
        link.close(4001, 'unauthorized')
        return
      }
    }
    link.peer = node
    link.ready = true
    links.set(node, [...(links.get(node) ?? []), link])
    await markPeer(node, true, peerLive(node, hi.live))
    log(`[actord] linked ${self} ⇄ ${node}`)
    void drain()
  }

  const onFrame = async (link: Link, raw: string): Promise<void> => {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      return
    }
    if (!link.ready) {
      if (frame.t === 'hi') await onReady(link, frame)
      else link.close(4002, 'hello first')
      return
    }
    const peer = link.peer!
    switch (frame.t) {
      case 'tx':
        await inbound(link, frame.env)
        return
      case 'ok':
        link.inflight.delete(frame.id)
        await mailbox.settleOutbound(peer, [frame.id])
        return
      case 'rcpt': {
        // Only the sender's own host may act on a receipt for it.
        let target: ActorAddress
        try {
          target = parse(frame.to)
        } catch {
          return
        }
        if (target.transport !== 'local') return
        await mailbox.recordReceipt(target.canonical, {
          envelopeId: frame.id,
          ackedBy: frame.by,
          ackedAt: frame.at,
          ...(frame.status ? { status: frame.status } : {}),
          ...(frame.reason ? { reason: frame.reason } : {}),
        })
        return
      }
      case 'live':
        await markPeer(peer, true, peerLive(peer, frame.live))
        return
    }
  }

  const onClose = async (link: Link): Promise<void> => {
    if (!link.ready || !link.peer) return
    link.ready = false
    const remaining = (links.get(link.peer) ?? []).filter(other => other !== link)
    links.set(link.peer, remaining)
    if (!remaining.some(other => other.ready)) {
      await markPeer(link.peer, false, [])
      log(`[actord] lost ${link.peer}`)
    }
  }

  // ── outbound: drain queues onto links ──────────────────────────────
  const drain = async (): Promise<void> => {
    if (draining || stopped) return
    draining = true
    try {
      const nodes = new Set([...(await mailbox.queuedNodes()), ...links.keys()])
      for (const node of nodes) {
        const link = readyLink(node)
        const now = Date.now()

        const pending = await mailbox.pendingOutbound(node)
        const expired = pending.filter(
          item => now - Date.parse(item.queuedAt) > retryWindowMs,
        )
        if (expired.length > 0) {
          await mailbox.settleOutbound(node, expired.map(item => item.envelope.id))
          for (const { envelope } of expired) {
            await mailbox.deadLetter(envelope.to, [envelope], 'unacked')
            await mailbox.recordReceipt(envelope.from, {
              envelopeId: envelope.id,
              ackedBy: `node:${node}`,
              ackedAt: new Date().toISOString(),
              status: 'dead',
              reason: link
                ? `node ${node} never confirmed it`
                : `no link to node ${node} (is actord running there, and listed in nodes.json?)`,
            })
          }
        }
        if (link) {
          for (const { envelope } of pending) {
            if (expired.some(item => item.envelope.id === envelope.id)) continue
            const last = link.inflight.get(envelope.id)
            if (last !== undefined && now - last < resendMs) continue
            link.inflight.set(envelope.id, now)
            sendFrame(link, { t: 'tx', env: stamp(envelope) })
          }
        }

        const receipts = await mailbox.pendingReceipts(node)
        const stale = receipts.filter(
          receipt => now - Date.parse(receipt.ackedAt) > retryWindowMs,
        )
        if (link) {
          // Best effort, like a local receipt: written to the socket is sent.
          for (const receipt of receipts) {
            sendFrame(link, {
              t: 'rcpt',
              to: receipt.to,
              id: receipt.envelopeId,
              by: qualify(receipt.ackedBy),
              at: receipt.ackedAt,
              ...(receipt.status ? { status: receipt.status } : {}),
              ...(receipt.reason ? { reason: receipt.reason } : {}),
            })
          }
          await mailbox.settleReceipts(node, receipts.map(receipt => receipt.envelopeId))
        } else if (stale.length > 0) {
          await mailbox.settleReceipts(node, stale.map(receipt => receipt.envelopeId))
        }
      }
    } catch (error) {
      log(`[actord] drain failed: ${error}`)
    } finally {
      draining = false
    }
  }

  const announce = async (): Promise<void> => {
    if (stopped) return
    try {
      const live = await localLive()
      const encoded = JSON.stringify(live)
      if (encoded === lastLive && Date.now() - lastLiveAt < PRESENCE_HEARTBEAT_MS) return
      lastLive = encoded
      lastLiveAt = Date.now()
      for (const node of links.keys()) {
        const link = readyLink(node)
        if (link) sendFrame(link, { t: 'live', live })
      }
    } catch (error) {
      log(`[actord] presence failed: ${error}`)
    }
  }

  // ── server ─────────────────────────────────────────────────────────
  let server: ReturnType<typeof Bun.serve> | undefined
  if (listen) {
    server = Bun.serve<{ link: Link }>({
      hostname: listen.hostname,
      port: listen.port,
      fetch(request, srv) {
        if (new URL(request.url).pathname !== ACTOR_NET_PATH) {
          return new Response('actor-net\n', { status: 404 })
        }
        const link: Link = {
          send: () => {},
          close: () => {},
          ready: false,
          inflight: new Map(),
        }
        if (srv.upgrade(request, { data: { link } })) return undefined
        return new Response('upgrade required\n', { status: 426 })
      },
      websocket: {
        open(ws) {
          const link = ws.data.link
          link.send = text => void ws.send(text)
          link.close = (code, reason) => ws.close(code, reason)
          void sendHi(link)
        },
        message(ws, message) {
          void onFrame(ws.data.link, String(message))
        },
        close(ws) {
          void onClose(ws.data.link)
        },
      },
    })
  }

  // ── client: dial every configured peer, redial on loss ─────────────
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sockets = new Set<WebSocket>()
  const dial = (configured: string, url: string, backoff = 1_000): void => {
    if (stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(peerUrl(url))
    } catch (error) {
      log(`[actord] bad peer URL for ${configured}: ${error}`)
      return
    }
    sockets.add(socket)
    const link: Link = {
      send: text => socket.readyState === WebSocket.OPEN && socket.send(text),
      close: (code, reason) => socket.close(code, reason),
      ready: false,
      inflight: new Map(),
    }
    let wasReady = false
    socket.addEventListener('open', () => void sendHi(link))
    socket.addEventListener('message', event => {
      void onFrame(link, String(event.data)).then(() => {
        if (link.ready && !wasReady) {
          wasReady = true
          if (link.peer !== normalizeNodeName(configured)) {
            log(`[actord] nodes.json calls ${url} "${configured}", but it says it is "${link.peer}"`)
          }
        }
      })
    })
    socket.addEventListener('close', () => {
      sockets.delete(socket)
      void onClose(link)
      if (stopped) return
      const next = wasReady ? 1_000 : Math.min(backoff * 2, MAX_REDIAL_MS)
      const timer = setTimeout(() => {
        timers.delete(timer)
        dial(configured, url, next)
      }, wasReady ? 1_000 : backoff)
      timers.add(timer)
    })
    socket.addEventListener('error', () => {
      // close follows; redial is scheduled there.
    })
  }

  const peers = options.peers ?? loadPeerTable(mailbox.root)
  for (const [node, url] of Object.entries(peers)) {
    if (normalizeNodeName(node) !== self) dial(node, url)
  }

  // ── loops ──────────────────────────────────────────────────────────
  const tick = setInterval(() => void drain(), tickMs)
  const presence = setInterval(() => void announce(), presenceMs)
  const watchers: FSWatcher[] = []
  for (const kind of ['outbox', 'rcpt']) {
    const dir = join(mailbox.root, '.net', kind)
    try {
      mkdirSync(dir, { recursive: true })
      // A session's send lands here; wake now rather than at the next tick.
      watchers.push(watch(dir, () => void drain()))
    } catch {
      // Tick still drains.
    }
  }

  return {
    node: self,
    url: server ? `ws://${listen && listen.hostname}:${server.port}${ACTOR_NET_PATH}` : undefined,
    connectedPeers: () =>
      [...links.entries()]
        .filter(([, list]) => list.some(link => link.ready))
        .map(([node]) => node)
        .sort(),
    async stop() {
      stopped = true
      clearInterval(tick)
      clearInterval(presence)
      for (const timer of timers) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      for (const socket of sockets) socket.close(1001, 'actord stopping')
      server?.stop(true)
      for (const node of links.keys()) await markPeer(node, false, [])
      links.clear()
    },
  }
}
