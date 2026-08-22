import { z } from 'zod/v4'
import {
  createCurrentActorRuntime,
  getCurrentActorAddress,
} from '../../actor/currentActor.js'
import {
  LispMetaInterpreter,
  type LispValue,
} from '../../actor/LispMetaInterpreter.js'
import {
  buildTool,
  type ToolDef,
  type ToolInputJSONSchema,
} from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { flattenUnionSchema } from '../MemoryTool/flattenSchema.js'
import { EVAL_APPLY_TOOL_NAME } from './constants.js'

export { EVAL_APPLY_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    z.object({
      action: z.literal('eval'),
      source: z
        .string()
        .min(1)
        .describe(
          'One or more Lisp expressions. Definitions persist for this actor and later eval/apply calls.',
        ),
    }),
    z.object({
      action: z.literal('apply'),
      procedure: z
        .string()
        .min(1)
        .describe(
          'One Lisp expression that evaluates to a procedure: a bound name, primitive, or lambda.',
        ),
      args: z
        .array(z.unknown())
        .describe('Already-evaluated JSON values passed to the procedure.'),
    }),
    z.object({ action: z.literal('bindings') }),
    z.object({
      action: z.literal('reset'),
      confirm: z
        .literal(true)
        .describe('Must be true; reset discards this actor interpreter frame.'),
    }),
  ]),
)

const bindingSchema = z.object({
  name: z.string(),
  kind: z.enum(['procedure', 'value']),
  value: z.unknown().optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.enum(['eval', 'apply', 'bindings', 'reset']),
    scope: z.string(),
    value: z.unknown().optional(),
    bindings: z.array(bindingSchema).optional(),
    message: z.string(),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
export type Output = z.infer<ReturnType<typeof outputSchema>>

const interpreters = new Map<string, LispMetaInterpreter>()

function interpreterFor(scope = getCurrentActorAddress()): LispMetaInterpreter {
  let interpreter = interpreters.get(scope)
  if (!interpreter) {
    // Actor traffic must remain visible through ActorTool. Disabling tx/rx in
    // this interpreter prevents a previously-defined procedure from becoming
    // a hidden messaging side channel; programs return a decision/payload and
    // the agent sends it with the visibly rendered ActorTool call.
    interpreter = new LispMetaInterpreter(
      createCurrentActorRuntime(),
      10_000,
      false,
    )
    interpreters.set(scope, interpreter)
  }
  return interpreter
}

function resetInterpreter(scope = getCurrentActorAddress()): void {
  interpreters.delete(scope)
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'function') return '<procedure>'
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(jsonSafe(value))
}

export const EvalApplyTool = buildTool({
  name: EVAL_APPLY_TOOL_NAME,
  aliases: ['EvalApplyTool', 'meta_eval'],
  searchHint:
    'SICP meta interpreter persistent Lisp eval apply procedures compose agent logic',
  shouldDefer: false,
  maxResultSizeChars: 100_000,
  async description() {
    return 'SICP-style persistent meta-interpreter: evaluate Lisp programs, define reusable procedures, and explicitly apply procedures to values.'
  },
  async prompt() {
    return `This is the SICP eval/apply capability, not a delivery approval gate. Use it when the agent needs a small persistent language to express recursion, higher-order procedures, stateful definitions, branching, or coordination logic that is awkward to reproduce as prose/tool-call chains.

- action="eval" evaluates Lisp source in a persistent environment scoped to the current actor. Multiple expressions are allowed; define/set! survive later calls.
- action="apply" is the explicit APPLY half: evaluate one procedure expression in that environment, then invoke it with the JSON values in args.
- action="bindings" makes the persistent frame inspectable.
- action="reset", confirm=true discards the frame.

Supported forms: quote, if, begin, define, set!, lambda, let; primitives: + - * / = < > not, list/car/cdr/cons/length/json and self. Examples:
  eval: (define twice (lambda (x) (* x 2)))
  apply: procedure="twice", args=[21]  => 42

The interpreter is bounded by an evaluation step limit and has no shell, filesystem, tx, or rx primitive. Actor conversations must go through ActorTool so destination, correlation and payload remain visible in the transcript.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })
    if (!isFirstPartyAnthropicBaseUrl()) {
      return flattenUnionSchema(schema, 'action') as ToolInputJSONSchema
    }
    schema.type = 'object'
    return schema as ToolInputJSONSchema
  },
  get outputSchema() {
    return outputSchema()
  },
  userFacingName() {
    return 'Eval/Apply'
  },
  isConcurrencySafe(input) {
    return input.action === 'bindings'
  },
  isReadOnly(input) {
    return input.action === 'bindings'
  },
  interruptBehavior() {
    return 'cancel'
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (!input.action) return null
    if (input.action === 'eval') {
      return `eval ${input.source?.replace(/\s+/g, ' ').slice(0, 120) ?? ''}`.trim()
    }
    if (input.action === 'apply') {
      return `apply ${input.procedure ?? ''}`.trim()
    }
    return input.action
  },
  async call(input: Input) {
    const scope = getCurrentActorAddress()
    if (input.action === 'reset') {
      resetInterpreter(scope)
      return {
        data: {
          success: true,
          action: 'reset' as const,
          scope,
          message: `Reset interpreter frame for ${scope}`,
        },
      }
    }

    const interpreter = interpreterFor(scope)
    if (input.action === 'bindings') {
      const bindings = interpreter.bindings().map(binding => ({
        ...binding,
        ...(binding.value === undefined
          ? {}
          : { value: jsonSafe(binding.value) }),
      }))
      return {
        data: {
          success: true,
          action: 'bindings' as const,
          scope,
          bindings,
          message: `${bindings.length} binding(s) in ${scope}`,
        },
      }
    }

    if (input.action === 'eval') {
      const value = jsonSafe(await interpreter.evaluate(input.source))
      return {
        data: {
          success: true,
          action: 'eval' as const,
          scope,
          value,
          message: `eval => ${renderValue(value)}`,
        },
      }
    }

    const value = jsonSafe(
      await interpreter.apply(input.procedure, input.args as LispValue[]),
    )
    return {
      data: {
        success: true,
        action: 'apply' as const,
        scope,
        value,
        message: `apply ${input.procedure} => ${renderValue(value)}`,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
  renderToolResultMessage(output: Output) {
    return output.message
  },
} satisfies ToolDef<InputSchema, Output>)
