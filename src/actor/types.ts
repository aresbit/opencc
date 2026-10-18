import { randomUUID } from 'crypto'
import { hostname } from 'os'

export const ACTOR_PROTOCOL_VERSION = 1

export type ActorAddress = {
  /**
   * local     a mailbox on this host
   * node      a mailbox on another host, reached through actord (`name@node`)
   * websocket legacy: an actor behind a matebot worker URL
   */
  transport: 'local' | 'node' | 'websocket'
  endpoint?: string
  /** The host that owns the mailbox. Set only when it is not this host. */
  node?: string
  team: string
  name: string
  canonical: string
}

/**
 * Normalize a node name: lowercase, [a-z0-9-] only.
 *
 * Node names are identities, not locators — the IP that reaches a node lives
 * in actord's peer table, so a host that changes network keeps its address.
 */
export function normalizeNodeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** This host's node name: OPENCC_NODE, else the hostname. */
export function getLocalNodeName(): string {
  const configured = process.env.OPENCC_NODE?.trim()
  return normalizeNodeName(configured || hostname()) || 'localhost'
}

/**
 * Split a trailing `@node` off an actor path.
 *
 * Runs on the still-encoded path: `localActorAddress` percent-encodes team and
 * name, so an `@` that is part of a name arrives as `%40` and only a literal
 * `@` in the last segment can be the node separator.
 */
function splitNode(path: string): [string, string | undefined] {
  const lastSlash = path.lastIndexOf('/')
  const at = path.lastIndexOf('@')
  if (at <= lastSlash) return [path, undefined]
  const node = normalizeNodeName(decodeURIComponent(path.slice(at + 1)))
  if (!node) throw new Error(`Invalid node in actor address: ${path}`)
  return [path.slice(0, at), node]
}

/** `actor://team/name` qualified with a node, for an address that leaves this host. */
export function nodeActorAddress(team: string, name: string, node: string): string {
  return `${localActorAddress(team, name)}@${normalizeNodeName(node)}`
}

export type ActorEnvelope<T = unknown> = {
  v: typeof ACTOR_PROTOCOL_VERSION
  id: string
  from: string
  to: string
  kind: string
  payload: T
  sentAt: string
  correlationId?: string
  replyTo?: string
  ttlMs?: number
  metadata?: Record<string, unknown>
}

function splitActorPath(path: string, defaultTeam?: string): [string, string] {
  const clean = path.replace(/^\/+/, '')
  const slash = clean.indexOf('/')
  if (slash < 0) {
    if (!defaultTeam) {
      throw new Error(`Actor address "${path}" needs a team`)
    }
    return [defaultTeam, decodeURIComponent(clean)]
  }
  const team = decodeURIComponent(clean.slice(0, slash))
  const name = decodeURIComponent(clean.slice(slash + 1))
  if (!team || !name || name.includes('/')) {
    throw new Error(`Invalid actor address: ${path}`)
  }
  return [team, name]
}

export function localActorAddress(team: string, name: string): string {
  if (!team.trim() || !name.trim())
    throw new Error('Actor team and name are required')
  return `actor://${encodeURIComponent(team)}/${encodeURIComponent(name)}`
}

/**
 * Address forms:
 *   actor://team/name            durable local mailbox
 *   actor://team/name@node       mailbox on another host (via actord)
 *   name, name@node              the same, in defaultTeam
 *   ws://host:port/ws#team/name  legacy: actor behind a matebot worker
 *
 * `@<this host's node>` parses as local, so an address stays valid on the
 * host that owns it and every comparison against a local address still holds.
 */
export function parseActorAddress(
  value: string,
  defaultTeam?: string,
  localNode: string = getLocalNodeName(),
): ActorAddress {
  const parsed = parseNodeLess(value, defaultTeam)
  if (parsed.transport !== 'local' || !parsed.node) return parsed
  if (parsed.node === normalizeNodeName(localNode)) {
    const { node: _own, ...local } = parsed
    return local
  }
  return {
    ...parsed,
    transport: 'node',
    canonical: nodeActorAddress(parsed.team, parsed.name, parsed.node),
  }
}

function parseNodeLess(value: string, defaultTeam?: string): ActorAddress {
  const input = value.trim()
  if (!input) throw new Error('Actor address is required')
  if (/^wss?:\/\//.test(input)) {
    const url = new URL(input)
    const [team, name] = splitActorPath(url.hash.slice(1), defaultTeam)
    url.hash = ''
    return {
      transport: 'websocket',
      endpoint: url.toString(),
      team,
      name,
      canonical: `${url.toString()}#${encodeURIComponent(team)}/${encodeURIComponent(name)}`,
    }
  }
  if (input.startsWith('actor://')) {
    const url = new URL(input)
    const [path, node] = splitNode(`${url.hostname}${url.pathname}`)
    const [team, name] = splitActorPath(path)
    return {
      transport: 'local',
      ...(node ? { node } : {}),
      team,
      name,
      canonical: localActorAddress(team, name),
    }
  }
  const [path, node] = splitNode(input)
  const [team, name] = splitActorPath(path, defaultTeam)
  return {
    transport: 'local',
    ...(node ? { node } : {}),
    team,
    name,
    canonical: localActorAddress(team, name),
  }
}

export function createActorEnvelope<T>(input: {
  from: string
  to: string
  payload: T
  kind?: string
  correlationId?: string
  replyTo?: string
  ttlMs?: number
  metadata?: Record<string, unknown>
}): ActorEnvelope<T> {
  return {
    v: ACTOR_PROTOCOL_VERSION,
    id: randomUUID(),
    from: input.from,
    to: input.to,
    kind: input.kind ?? 'message',
    payload: input.payload,
    sentAt: new Date().toISOString(),
    correlationId: input.correlationId,
    replyTo: input.replyTo,
    ttlMs: input.ttlMs,
    metadata: input.metadata,
  }
}

export function isExpiredActorEnvelope(
  envelope: ActorEnvelope,
  now = Date.now(),
): boolean {
  return Boolean(
    envelope.ttlMs && Date.parse(envelope.sentAt) + envelope.ttlMs <= now,
  )
}
