import { randomUUID, timingSafeEqual } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'
import { LocalActorMailbox } from '../actor/LocalActorMailbox.js'
import {
  ACTOR_PROTOCOL_VERSION,
  type ActorEnvelope,
  localActorAddress,
  parseActorAddress,
} from '../actor/types.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import {
  MATEBOT_WS_PROTOCOL_VERSION,
  type MateBotRemoteLaunchInput,
  type MateBotRemoteStatus,
} from './MateBotRemoteTransport.js'

type WorkerEvent = {
  cursor: string
  message: SDKMessage
}

type WorkerTask = {
  id: string
  title: string
  cwd: string
  status: MateBotRemoteStatus
  events: WorkerEvent[]
  nextCursor: number
  process?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  result?: string
  error?: string
  actorAddress: string
}

type ClientFrame = {
  v?: unknown
  type?: unknown
  request_id?: unknown
  authorization?: unknown
  task_id?: unknown
  after?: unknown
  task?: unknown
  envelope?: unknown
  address?: unknown
  limit?: unknown
}

export type MateBotRemoteWorkerOptions = {
  port?: number
  hostname?: string
  token?: string
  workspaceRoot?: string
  maxConcurrent?: number
  cliPath?: string
  permissionMode?: string
  actorMailboxRoot?: string
}

export type MateBotRemoteWorkerServer = {
  hostname: string
  port: number
  url: string
  stop: (closeActiveConnections?: boolean) => void
}

function secureTokenEquals(actual: unknown, expected?: string): boolean {
  if (!expected) return true
  if (typeof actual !== 'string') return false
  const wanted = Buffer.from(`Bearer ${expected}`)
  const received = Buffer.from(actual)
  return wanted.length === received.length && timingSafeEqual(wanted, received)
}

function parseLaunchInput(value: unknown): MateBotRemoteLaunchInput {
  if (!value || typeof value !== 'object') {
    throw new Error('task must be an object')
  }
  const input = value as Record<string, unknown>
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
    throw new Error('task.prompt must be a non-empty string')
  }
  return {
    prompt: input.prompt,
    description:
      typeof input.description === 'string' && input.description.trim()
        ? input.description
        : 'Remote MateBot task',
    role:
      typeof input.role === 'string' && input.role.trim()
        ? input.role
        : 'general-purpose',
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    metadata:
      input.metadata && typeof input.metadata === 'object'
        ? (input.metadata as Record<string, unknown>)
        : undefined,
  }
}

function resolveTaskCwd(root: string, requested?: string): string {
  const cwd = resolve(requested || root)
  const pathFromRoot = relative(root, cwd)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`task.cwd must stay inside worker root: ${root}`)
  }
  return cwd
}

function resultMessage(
  taskId: string,
  status: 'completed' | 'failed' | 'cancelled',
  text: string,
): SDKMessage {
  return {
    type: 'result',
    subtype: status === 'completed' ? 'success' : 'error_during_execution',
    is_error: status !== 'completed',
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: text,
    session_id: taskId,
    total_cost_usd: 0,
    usage: {},
  } as SDKMessage
}

function appendEvent(task: WorkerTask, message: SDKMessage): void {
  task.nextCursor += 1
  task.events.push({ cursor: String(task.nextCursor), message })
}

async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: SDKMessage) => void,
): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          const parsed = JSON.parse(line)
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.type === 'string'
          ) {
            onMessage(parsed as SDKMessage)
          }
        } catch {
          // stdout outside the stream-json protocol is ignored.
        }
      }
      newline = buffer.indexOf('\n')
    }
  }
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

/**
 * Starts a small, self-hostable MateBot execution plane. The server is
 * intentionally stateless beyond its in-memory task table; durable orchestration
 * remains in the coordinator's task graph and eval/apply ledger.
 */
export function createMateBotRemoteWorkerServer(
  options: MateBotRemoteWorkerOptions = {},
): MateBotRemoteWorkerServer {
  const hostname = options.hostname ?? '127.0.0.1'
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())
  const maxConcurrent = options.maxConcurrent ?? 8
  const cliPath =
    options.cliPath ?? resolve(import.meta.dir, '../entrypoints/cli.tsx')
  const permissionMode = options.permissionMode ?? 'acceptEdits'
  const tasks = new Map<string, WorkerTask>()
  const actorMailbox = new LocalActorMailbox(
    options.actorMailboxRoot ?? resolve(workspaceRoot, '.matebot/actors'),
  )

  const activeCount = () =>
    [...tasks.values()].filter(task =>
      ['queued', 'running', 'idle'].includes(task.status),
    ).length

  const runTask = async (
    task: WorkerTask,
    input: MateBotRemoteLaunchInput,
  ): Promise<void> => {
    task.status = 'running'
    const child = Bun.spawn(
      [
        process.execPath,
        cliPath,
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--permission-mode',
        permissionMode,
        '--matebot',
      ],
      {
        cwd: task.cwd,
        env: {
          ...process.env,
          OPENCC_MATEBOT: '1',
          MATEBOT_ACTOR_ADDRESS: task.actorAddress,
          ...(options.token ? { MATEBOT_ACTOR_TOKEN: options.token } : {}),
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    task.process = child
    child.stdin.write(input.prompt)
    child.stdin.end()

    const stderrPromise = readText(child.stderr)
    await readJsonLines(child.stdout, message => appendEvent(task, message))
    const exitCode = await child.exited
    const stderr = (await stderrPromise).trim()
    task.process = undefined
    if (task.status === 'cancelled') return

    const existingResult = [...task.events]
      .reverse()
      .find(event => event.message.type === 'result')
    if (exitCode === 0) {
      task.status = 'completed'
      task.result = existingResult
        ? String((existingResult.message as { result?: unknown }).result ?? '')
        : 'Remote task completed'
      if (!existingResult) {
        appendEvent(task, resultMessage(task.id, 'completed', task.result))
      }
    } else {
      task.status = 'failed'
      task.error = stderr || `OpenCC worker exited with code ${exitCode}`
      if (!existingResult) {
        appendEvent(task, resultMessage(task.id, 'failed', task.error))
      }
    }
  }

  const server = Bun.serve<{ connectedAt: number }>({
    hostname,
    port: options.port ?? 8787,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          active: activeCount(),
          tasks: tasks.size,
        })
      }
      if (
        url.pathname !== '/ws' ||
        !bunServer.upgrade(request, { data: { connectedAt: Date.now() } })
      ) {
        return new Response('MateBot worker: connect with WebSocket at /ws', {
          status: 426,
        })
      }
    },
    websocket: {
      async message(socket, raw) {
        const send = (frame: Record<string, unknown>) =>
          socket.send(
            JSON.stringify({ v: MATEBOT_WS_PROTOCOL_VERSION, ...frame }),
          )
        let frame: ClientFrame
        try {
          frame = JSON.parse(String(raw)) as ClientFrame
        } catch {
          send({ type: 'error', error: 'invalid JSON' })
          return
        }
        const requestId =
          typeof frame.request_id === 'string' ? frame.request_id : undefined
        const fail = (error: unknown) =>
          send({
            type: 'error',
            request_id: requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        if (frame.v !== MATEBOT_WS_PROTOCOL_VERSION) {
          fail(`unsupported protocol version: ${String(frame.v)}`)
          return
        }
        if (!requestId) {
          fail('request_id is required')
          return
        }
        if (!secureTokenEquals(frame.authorization, options.token)) {
          fail('unauthorized')
          return
        }

        try {
          if (frame.type === 'actor.tx') {
            const envelope = frame.envelope as ActorEnvelope | undefined
            if (
              !envelope ||
              envelope.v !== ACTOR_PROTOCOL_VERSION ||
              typeof envelope.id !== 'string' ||
              typeof envelope.to !== 'string'
            ) {
              fail('invalid actor envelope')
              return
            }
            const destination = parseActorAddress(envelope.to)
            await actorMailbox.send({
              ...envelope,
              to: localActorAddress(destination.team, destination.name),
            })
            send({
              type: 'actor.ack',
              request_id: requestId,
              envelope_id: envelope.id,
            })
            return
          }

          if (frame.type === 'actor.rx') {
            if (typeof frame.address !== 'string') {
              fail('actor.rx address is required')
              return
            }
            const address = parseActorAddress(frame.address)
            const limit =
              typeof frame.limit === 'number' && Number.isFinite(frame.limit)
                ? Math.max(1, Math.min(100, Math.floor(frame.limit)))
                : 1
            const envelopes = await actorMailbox.receive(
              localActorAddress(address.team, address.name),
              limit,
            )
            send({
              type: 'actor.messages',
              request_id: requestId,
              envelopes,
            })
            return
          }

          if (frame.type === 'task.start') {
            if (activeCount() >= maxConcurrent) {
              fail(`worker concurrency limit reached (${maxConcurrent})`)
              return
            }
            const input = parseLaunchInput(frame.task)
            const id = randomUUID()
            const task: WorkerTask = {
              id,
              title: input.description,
              cwd: resolveTaskCwd(workspaceRoot, input.cwd),
              status: 'queued',
              events: [],
              nextCursor: 0,
              actorAddress: `ws://127.0.0.1:${server.port}/ws#remote/${id}`,
            }
            tasks.set(id, task)
            send({
              type: 'task.accepted',
              request_id: requestId,
              task_id: id,
              title: task.title,
              url: `matebot://${hostname}:${server.port}/${id}`,
              actor_address: task.actorAddress,
            })
            void runTask(task, input).catch(error => {
              task.status = 'failed'
              task.error =
                error instanceof Error ? error.message : String(error)
              appendEvent(task, resultMessage(task.id, 'failed', task.error))
            })
            return
          }

          if (frame.type === 'task.poll') {
            const taskId =
              typeof frame.task_id === 'string' ? frame.task_id : ''
            const task = tasks.get(taskId)
            if (!task) {
              fail(`unknown task: ${taskId}`)
              return
            }
            const after = Number.parseInt(
              typeof frame.after === 'string' ? frame.after : '0',
              10,
            )
            const newEvents = task.events.filter(
              event =>
                Number.parseInt(event.cursor, 10) >
                (Number.isNaN(after) ? 0 : after),
            )
            send({
              type: 'task.snapshot',
              request_id: requestId,
              task_id: task.id,
              status: task.status,
              cursor: task.events.at(-1)?.cursor ?? null,
              events: newEvents,
              result: task.result,
              error: task.error,
            })
            return
          }

          if (frame.type === 'task.cancel') {
            const taskId =
              typeof frame.task_id === 'string' ? frame.task_id : ''
            const task = tasks.get(taskId)
            if (!task) {
              fail(`unknown task: ${taskId}`)
              return
            }
            if (['queued', 'running', 'idle'].includes(task.status)) {
              task.status = 'cancelled'
              task.process?.kill()
              appendEvent(
                task,
                resultMessage(task.id, 'cancelled', 'Remote task cancelled'),
              )
            }
            send({
              type: 'task.cancelled',
              request_id: requestId,
              task_id: task.id,
            })
            return
          }

          fail(`unsupported message type: ${String(frame.type)}`)
        } catch (error) {
          fail(error)
        }
      },
    },
  })

  return {
    hostname,
    port: server.port,
    url: `ws://${hostname}:${server.port}/ws`,
    stop: closeActiveConnections => server.stop(closeActiveConnections),
  }
}
