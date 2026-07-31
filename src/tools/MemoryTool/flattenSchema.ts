/**
 * Flatten a discriminated-union JSON Schema into a single object schema.
 *
 * Why this exists: `z.discriminatedUnion` emits
 *
 *     { type: "object", oneOf: [ {...}, {...} ] }
 *
 * with no top-level `properties`. First-party Anthropic passes the schema
 * through to the model as text, so `oneOf` reads fine. Third-party endpoints
 * reached via ANTHROPIC_BASE_URL are a different story: routers that convert
 * Anthropic `input_schema` → OpenAI `function.parameters`, and providers that
 * do constrained decoding against the schema, generally read
 * `parameters.properties`. Finding nothing there, they present the tool as
 * taking no arguments — and the model then invents a call shape, which is
 * exactly the "参数错误" loop.
 *
 * This is not speculation about JSON Schema support in the abstract: the MCP
 * entrypoint in this same repo already skips root-level oneOf/anyOf schemas
 * because the MCP SDK rejects them (see entrypoints/mcp.ts, issue 8014).
 *
 * The flattened form unions every arm's properties into one object, keeps only
 * the discriminator as required, and records each field's owning actions in
 * its description. It is less precise than `oneOf` — nothing stops a caller
 * pairing `action: "list"` with `overcomeReason` — but precision is not lost
 * overall, because the *runtime* schema is still the strict discriminated
 * union. A wrong combination fails validation with a message naming the valid
 * actions, rather than failing to be expressible at all.
 */

import type { JsonSchema7Type } from '../../utils/zodToJsonSchema.js'

type ObjectSchema = {
  type?: string
  properties?: Record<string, Record<string, unknown>>
  required?: string[]
  [key: string]: unknown
}

// inputJSONSchema is read once per tool per API request. zodToJsonSchema
// already caches by identity, so its result is a stable key for ours.
const cache = new WeakMap<JsonSchema7Type, JsonSchema7Type>()

/**
 * @param unionSchema output of zodToJsonSchema() on a discriminated union
 * @param discriminator the field the union switches on (e.g. "action")
 */
export function flattenUnionSchema(
  unionSchema: JsonSchema7Type,
  discriminator: string,
): JsonSchema7Type {
  const hit = cache.get(unionSchema)
  if (hit) return hit

  const arms = unionSchema.oneOf as ObjectSchema[] | undefined
  if (!Array.isArray(arms) || arms.length === 0) {
    return unionSchema
  }

  const properties: Record<string, Record<string, unknown>> = {}
  const discriminatorValues: string[] = []
  /** field → actions that accept it */
  const usedBy = new Map<string, string[]>()
  /** field → actions that require it */
  const requiredBy = new Map<string, string[]>()

  for (const arm of arms) {
    const armProps = arm.properties ?? {}
    const discProp = armProps[discriminator]
    const value =
      discProp && typeof discProp.const === 'string' ? discProp.const : undefined
    if (value) discriminatorValues.push(value)

    for (const [key, schema] of Object.entries(armProps)) {
      if (key === discriminator) continue
      // First arm to define a field wins. Fields shared across arms have
      // identical types here by construction (they come from the same zod
      // fragments), so this is a merge, not a conflict.
      properties[key] ??= { ...schema }
      if (value) {
        usedBy.set(key, [...(usedBy.get(key) ?? []), value])
        if (arm.required?.includes(key)) {
          requiredBy.set(key, [...(requiredBy.get(key) ?? []), value])
        }
      }
    }
  }

  // Re-attach the per-field action list to the description. Without it the
  // flattened schema says nothing about which fields belong to which action,
  // which is the one thing oneOf was communicating.
  for (const [key, schema] of Object.entries(properties)) {
    const required = requiredBy.get(key) ?? []
    const optional = (usedBy.get(key) ?? []).filter(a => !required.includes(a))
    const parts: string[] = []
    if (required.length > 0) parts.push(`required for: ${required.join(', ')}`)
    if (optional.length > 0) parts.push(`optional for: ${optional.join(', ')}`)
    if (parts.length === 0) continue
    const existing =
      typeof schema.description === 'string' ? `${schema.description} ` : ''
    schema.description = `${existing}(${parts.join('; ')})`
  }

  const flattened: JsonSchema7Type = {
    type: 'object',
    properties: {
      [discriminator]: {
        type: 'string',
        enum: discriminatorValues,
        description: `Which operation to perform. Every other field is scoped to particular actions — see each field's description.`,
      },
      ...properties,
    },
    required: [discriminator],
  }
  cache.set(unionSchema, flattened)
  return flattened
}
