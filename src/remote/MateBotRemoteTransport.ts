import { randomUUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'

export const MATEBOT_WS_PROTOCOL_VERSION = 1

export type MateBotRemoteStatus =
  | 'queued'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type MateBotRemoteLaunchInput = {
  prompt: string
  description: string
  role: string
  cwd?: string
  metadata?: Record<string, unknown>
}

export type MateBotRemoteSession = {
  id: string
  title: string
  url: string
  actorAddress?: string
}

export type MateBotRemoteEventBatch = {
  newEvents: SDKMessage[]
  lastEventId: string | null
  sessionStatus: MateBotRemoteStatus
}

type ProtocolResponse = {
  v: number
  type: string
  request_id?: string
  task_id?: string
  title?: string
  url?: string
  status?: unknown
  cursor?: string | null
  events?: unknown[]
  result?: unknown
  error?: unknown
  actor_address?: string
}

type PendingRequest = {
  expected: Set<string>
  resolve: (message: ProtocolResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WebSocketLike = Pick<
  WebSocket,
  'readyState' | 'send' | 'close' | 'addEventListener' | 'removeEventListener'
>

type WebSocketFactory = (url: string) => WebSocketLike

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`MateBot WebSocket response is missing ${field}`)
  }
  return value
}

function parseStatus(value: unknown): MateBotRemoteStatus {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'idle' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  throw new Error(`MateBot WebSocket returned invalid status: ${String(value)}`)
}

function syntheticResult(
  status: 'completed' | 'failed',
  result: unknown,
): SDKMessage {
  return {
    type: 'result',
    subtype: status === 'completed' ? 'success' : 'error_during_execution',
    is_error: status === 'failed',
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result:
      typeof result === 'string'
        ? result
        : result === undefined
          ? ''
          : JSON.stringify(result),
    session_id: '',
    total_cost_usd: 0,
    usage: {},
  } as SDKMessage
}

function parseEvent(value: unknown): SDKMessage | null {
  const candidate =
    value && typeof value === 'object' && 'message' in value
      ? (value as { message: unknown }).message
      : value
  return candidate &&
    typeof candidate === 'object' &&
    'type' in candidate &&
    typeof candidate.type === 'string'
    ? (candidate as SDKMessage)
    : null
}

/**
 * Minimal request/response protocol over one WebSocket connection.
 *
 * Client -> server:
 *   task.start  { request_id, authorization?, task }
 *   task.poll   { request_id, authorization?, task_id, after }
 *   task.cancel { request_id, authorization?, task_id }
 *
 * Server -> client:
 *   task.accepted  { request_id, task_id, title?, url? }
 *   task.snapshot  { request_id, task_id, status, cursor?, events?, result?, error? }
 *   task.cancelled { request_id, task_id }
 *   error          { request_id, error }
 */
export class MateBotRemoteTransport {
  readonly url: string
  private readonly token?: string
  private readonly socketFactory: WebSocketFactory
  private socket: WebSocketLike | null = null
  private connecting: Promise<WebSocketLike> | null = null
  private readonly pending = new Map<string, PendingRequest>()

  constructor(
    url: string,
    token?: string,
    socketFactory: WebSocketFactory = value => new WebSocket(value),
  ) {
    if (!/^wss?:\/\//.test(url)) {
      throw new Error('MateBot remote URL must use ws:// or wss://')
    }
    this.url = url
    this.token = token
    this.socketFactory = socketFactory
  }

  private async connect(): Promise<WebSocketLike> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket
    if (this.connecting) return this.connecting
    this.connecting = new Promise<WebSocketLike>((resolve, reject) => {
      const socket = this.socketFactory(this.url)
      const onOpen = () => {
        cleanup()
        this.socket = socket
        this.connecting = null
        socket.addEventListener('message', this.onMessage)
        socket.addEventListener('close', this.onClose)
        socket.addEventListener('error', this.onSocketError)
        resolve(socket)
      }
      const onError = () => {
        cleanup()
        this.connecting = null
        reject(
          new Error(
            `Could not connect to MateBot remote WebSocket: ${this.url}`,
          ),
        )
      }
      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })
    return this.connecting
  }

  private readonly onMessage = (event: MessageEvent): void => {
    let message: ProtocolResponse
    try {
      message = JSON.parse(String(event.data)) as ProtocolResponse
    } catch {
      return
    }
    if (message.v !== MATEBOT_WS_PROTOCOL_VERSION || !message.request_id) return
    const pending = this.pending.get(message.request_id)
    if (!pending) return
    if (message.type === 'error') {
      clearTimeout(pending.timer)
      this.pending.delete(message.request_id)
      pending.reject(
        new Error(String(message.error ?? 'remote protocol error')),
      )
      return
    }
    if (!pending.expected.has(message.type)) return
    clearTimeout(pending.timer)
    this.pending.delete(message.request_id)
    pending.resolve(message)
  }

  private readonly onClose = (): void => {
    this.socket = null
    this.rejectPending(new Error('MateBot remote WebSocket disconnected'))
  }

  private readonly onSocketError = (): void => {
    if (this.socket?.readyState === WebSocket.CLOSED) {
      this.onClose()
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private async request(
    type: 'task.start' | 'task.poll' | 'task.cancel',
    payload: Record<string, unknown>,
    expected: string[],
  ): Promise<ProtocolResponse> {
    const socket = await this.connect()
    const requestId = randomUUID()
    const response = new Promise<ProtocolResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new Error(
            `MateBot remote timed out waiting for ${expected.join(' or ')}`,
          ),
        )
      }, 30_000)
      this.pending.set(requestId, {
        expected: new Set(expected),
        resolve,
        reject,
        timer,
      })
    })
    socket.send(
      JSON.stringify({
        v: MATEBOT_WS_PROTOCOL_VERSION,
        type,
        request_id: requestId,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...payload,
      }),
    )
    return response
  }

  async launch(input: MateBotRemoteLaunchInput): Promise<MateBotRemoteSession> {
    const response = await this.request('task.start', { task: input }, [
      'task.accepted',
    ])
    const id = requireString(response.task_id, 'task_id')
    return {
      id,
      title: response.title?.trim() || input.description,
      url: response.url?.trim() || `matebot://${id}`,
      actorAddress: response.actor_address?.trim() || undefined,
    }
  }

  async status(taskId: string): Promise<MateBotRemoteStatus> {
    const response = await this.request(
      'task.poll',
      { task_id: taskId, after: null },
      ['task.snapshot'],
    )
    return parseStatus(response.status)
  }

  async poll(
    taskId: string,
    afterId: string | null,
  ): Promise<MateBotRemoteEventBatch> {
    const response = await this.request(
      'task.poll',
      { task_id: taskId, after: afterId },
      ['task.snapshot'],
    )
    const status = parseStatus(response.status)
    const events = (response.events ?? [])
      .map(parseEvent)
      .filter((event): event is SDKMessage => event !== null)
    if (
      (status === 'completed' || status === 'failed') &&
      !events.some(event => event.type === 'result')
    ) {
      events.push(syntheticResult(status, response.result ?? response.error))
    }
    return {
      newEvents: events,
      lastEventId: response.cursor ?? afterId,
      sessionStatus: status,
    }
  }

  async cancel(taskId: string): Promise<void> {
    await this.request('task.cancel', { task_id: taskId }, ['task.cancelled'])
  }

  close(): void {
    this.socket?.close()
    this.socket = null
  }
}

let sharedTransport: MateBotRemoteTransport | null = null
let sharedKey = ''

export function isMateBotRemoteConfigured(): boolean {
  return Boolean(process.env.MATEBOT_REMOTE_WS_URL?.trim())
}

export function getMateBotRemoteTransport(): MateBotRemoteTransport {
  const url = process.env.MATEBOT_REMOTE_WS_URL?.trim()
  if (!url) {
    throw new Error(
      'MateBot remote execution requires MATEBOT_REMOTE_WS_URL (and optionally MATEBOT_REMOTE_TOKEN)',
    )
  }
  const token = process.env.MATEBOT_REMOTE_TOKEN?.trim()
  const key = `${url}\0${token ?? ''}`
  if (!sharedTransport || sharedKey !== key) {
    sharedTransport?.close()
    sharedTransport = new MateBotRemoteTransport(url, token)
    sharedKey = key
  }
  return sharedTransport
}
