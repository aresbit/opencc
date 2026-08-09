import { randomUUID } from 'crypto'

export const ACTOR_PROTOCOL_VERSION = 1

export type ActorAddress = {
  transport: 'local' | 'websocket'
  endpoint?: string
  team: string
  name: string
  canonical: string
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
 *   name                         local mailbox in defaultTeam
 *   ws://host:port/ws#team/name  actor reachable through a remote node
 */
export function parseActorAddress(
  value: string,
  defaultTeam?: string,
): ActorAddress {
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
    const [team, name] = splitActorPath(`${url.hostname}${url.pathname}`)
    return {
      transport: 'local',
      team,
      name,
      canonical: localActorAddress(team, name),
    }
  }
  const [team, name] = splitActorPath(input, defaultTeam)
  return {
    transport: 'local',
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
