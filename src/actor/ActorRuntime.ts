import { ActorWebSocketTransport } from './ActorWebSocketTransport.js'
import { LocalActorMailbox } from './LocalActorMailbox.js'
import {
  type ActorEnvelope,
  createActorEnvelope,
  localActorAddress,
  parseActorAddress,
} from './types.js'

export type ActorRuntimeOptions = {
  mailbox?: LocalActorMailbox
  token?: string
  pollIntervalMs?: number
}

export class ActorRuntime {
  readonly self: string
  private readonly mailbox: LocalActorMailbox
  private readonly remote: ActorWebSocketTransport
  private readonly pollIntervalMs: number

  constructor(self: string, options: ActorRuntimeOptions = {}) {
    this.self = parseActorAddress(self).canonical
    this.mailbox = options.mailbox ?? new LocalActorMailbox()
    this.remote = new ActorWebSocketTransport(options.token)
    this.pollIntervalMs = options.pollIntervalMs ?? 100
  }

  async tx<T>(
    to: string,
    payload: T,
    options: {
      kind?: string
      correlationId?: string
      replyTo?: string
      ttlMs?: number
      metadata?: Record<string, unknown>
    } = {},
  ): Promise<ActorEnvelope<T>> {
    const target = parseActorAddress(to, parseActorAddress(this.self).team)
    const envelope = createActorEnvelope({
      from: this.self,
      to: localActorAddress(target.team, target.name),
      payload,
      ...options,
    })
    if (target.transport === 'websocket') {
      await this.remote.send(target.endpoint!, envelope)
    } else {
      await this.mailbox.send(envelope)
    }
    return envelope
  }

  async rx(
    options: { limit?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ActorEnvelope[]> {
    const self = parseActorAddress(this.self)
    const timeoutMs = Math.max(0, options.timeoutMs ?? 0)
    const deadline = Date.now() + timeoutMs
    do {
      if (options.signal?.aborted) return []
      const address = localActorAddress(self.team, self.name)
      const envelopes =
        self.transport === 'websocket'
          ? await this.remote.receive(self.endpoint!, address, options.limit)
          : await this.mailbox.receive(address, options.limit)
      if (envelopes.length > 0 || Date.now() >= deadline) return envelopes
      await Bun.sleep(Math.min(this.pollIntervalMs, deadline - Date.now()))
    } while (Date.now() <= deadline)
    return []
  }
}
