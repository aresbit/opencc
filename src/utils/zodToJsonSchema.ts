/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same ZodTypeAny reference per session, so we can cache by identity.
const outputCache = new WeakMap<ZodTypeAny, JsonSchema7Type>()
const inputCache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * `io: 'input'` describes what a *caller* may send; `'output'` (zod's default)
 * describes what parsing produces. They differ for `.default()` fields: in
 * output mode the field is always present, so zod marks it `required` — which
 * tells the model it MUST pass `limit`/`offset`, and a call that omits them
 * reads as schema-violating. Tool input schemas want 'input'.
 */
export function zodToJsonSchema(
  schema: ZodTypeAny,
  options?: { io?: 'input' | 'output' },
): JsonSchema7Type {
  const io = options?.io ?? 'output'
  const cache = io === 'input' ? inputCache : outputCache
  const hit = cache.get(schema)
  if (hit) return hit
  const result = toJSONSchema(schema, { io }) as JsonSchema7Type
  // Anthropic API requires top-level type: "object". Zod discriminatedUnion
  // and union produce { oneOf: [...] } without a type field — add it here.
  if (!result.type && result.oneOf) {
    result.type = 'object'
  }
  cache.set(schema, result)
  return result
}
