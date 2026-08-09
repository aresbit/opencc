import type { ActorEnvelope } from './types.js'
import { ACTOR_PROTOCOL_VERSION } from './types.js'

type ActorResponse = {
  v?: unknown
  type?: unknown
  request_id?: unknown
  envelopes?: unknown
  error?: unknown
}

export class ActorWebSocketTransport {
  constructor(
    private readonly token?: string,
    private readonly timeoutMs = 30_000,
  ) {}

  private request(
    endpoint: string,
    frame: Record<string, unknown>,
    expectedType: string,
  ): Promise<ActorResponse> {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID()
      const socket = new WebSocket(endpoint)
      const timer = setTimeout(() => {
        socket.close()
        reject(
          new Error(`Actor WebSocket timed out waiting for ${expectedType}`),
        )
      }, this.timeoutMs)
      const finish = (error?: Error, response?: ActorResponse) => {
        clearTimeout(timer)
        socket.close()
        if (error) reject(error)
        else resolve(response ?? {})
      }
      socket.addEventListener('error', () =>
        finish(new Error(`Could not connect to actor node: ${endpoint}`)),
      )
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            v: ACTOR_PROTOCOL_VERSION,
            request_id: requestId,
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...frame,
          }),
        )
      })
      socket.addEventListener('message', event => {
        let response: ActorResponse
        try {
          response = JSON.parse(String(event.data)) as ActorResponse
        } catch {
          return
        }
        if (response.request_id !== requestId) return
        if (response.type === 'error') {
          finish(new Error(String(response.error ?? 'actor protocol error')))
          return
        }
        if (response.type === expectedType) finish(undefined, response)
      })
    })
  }

  async send(endpoint: string, envelope: ActorEnvelope): Promise<void> {
    await this.request(endpoint, { type: 'actor.tx', envelope }, 'actor.ack')
  }

  async receive(
    endpoint: string,
    address: string,
    limit = 1,
  ): Promise<ActorEnvelope[]> {
    const response = await this.request(
      endpoint,
      { type: 'actor.rx', address, limit },
      'actor.messages',
    )
    return Array.isArray(response.envelopes)
      ? (response.envelopes as ActorEnvelope[])
      : []
  }
}
