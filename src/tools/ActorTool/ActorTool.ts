import { z } from 'zod/v4'
import {
  createCurrentActorRuntime,
  getCurrentActorAddress,
} from '../../actor/currentActor.js'
import { LispMetaInterpreter } from '../../actor/LispMetaInterpreter.js'
import { parseActorAddress } from '../../actor/types.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getAgentName,
  getTeammateColor,
  getTeamName,
} from '../../utils/teammate.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { ACTOR_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['tx', 'rx', 'eval', 'self']),
    to: z.string().optional(),
    payload: z.unknown().optional(),
    kind: z.string().optional(),
    source: z.string().optional(),
    timeout_ms: z.number().int().min(0).max(30_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    correlation_id: z.string().optional(),
    ttl_ms: z.number().int().positive().optional(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    self: z.string(),
    envelope: z.unknown().optional(),
    envelopes: z.array(z.unknown()).optional(),
    value: z.unknown().optional(),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>

const interpreters = new Map<string, LispMetaInterpreter>()

function currentInterpreter(): LispMetaInterpreter {
  const teammateInterpreter = getTeammateContext()?.lispInterpreter
  if (teammateInterpreter) return teammateInterpreter
  const address = getCurrentActorAddress()
  let interpreter = interpreters.get(address)
  if (!interpreter) {
    interpreter = new LispMetaInterpreter(createCurrentActorRuntime())
    interpreters.set(address, interpreter)
  }
  return interpreter
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'function') return '<lambda>'
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

export const ActorTool = buildTool({
  name: ACTOR_TOOL_NAME,
  async description() {
    return 'Actor primitives for durable local or cross-IP tx/rx, plus a persistent Lisp meta-interpreter scoped to this agent address.'
  },
  async prompt() {
    return `Every complex agent is an actor. Use action="tx" to send an envelope, action="rx" to atomically receive, and action="eval" to run S-expressions. Addresses are actor://team/name locally or ws://host:port/ws#team/name remotely. Lisp exposes (tx address payload [kind]), (rx [timeout-ms] [limit]), self, define, lambda, let, if, begin, quote, list, car/cdr/cons, arithmetic and comparisons.`
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  userFacingName() {
    return 'Actor'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly(input) {
    return input.action === 'self'
  },
  renderToolUseMessage() {
    return null
  },
  async call(input: Input) {
    const runtime = createCurrentActorRuntime()
    if (input.action === 'self') {
      return { data: { success: true, self: runtime.self } }
    }
    if (input.action === 'eval') {
      if (!input.source?.trim()) throw new Error('source is required for eval')
      const value = await currentInterpreter().evaluate(input.source)
      return {
        data: { success: true, self: runtime.self, value: jsonSafe(value) },
      }
    }
    if (input.action === 'rx') {
      const envelopes = await runtime.rx({
        timeoutMs: input.timeout_ms,
        limit: input.limit,
      })
      return {
        data: { success: true, self: runtime.self, envelopes },
      }
    }
    if (!input.to?.trim()) throw new Error('to is required for tx')
    const envelope = await runtime.tx(input.to, input.payload ?? null, {
      kind: input.kind,
      correlationId: input.correlation_id,
      ttlMs: input.ttl_ms,
    })

    // Compatibility adapter: existing OpenCC agents still poll the teammate
    // mailbox while actor-native agents consume the durable envelope mailbox.
    const destination = parseActorAddress(input.to, getTeamName() || 'default')
    if (destination.transport === 'local') {
      await writeToMailbox(
        destination.name,
        {
          from: getAgentName() || runtime.self,
          text:
            typeof input.payload === 'string'
              ? input.payload
              : JSON.stringify(input.payload ?? null),
          timestamp: new Date().toISOString(),
          color: getTeammateColor(),
        },
        destination.team,
      )
    }
    return { data: { success: true, self: runtime.self, envelope } }
  },
} satisfies ToolDef)
