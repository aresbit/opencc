/**
 * JSON Schema → the types a generated binding exposes.
 *
 * MCP tools describe themselves with JSON Schema: `inputSchema` always,
 * `outputSchema` when the server promises structured results. Those schemas are
 * the contract, so the bindings carry them in full — nested objects, enums,
 * unions, arrays, local $refs — instead of the top-level field list the old
 * generator flattened them to.
 */

type Schema = Record<string, unknown>

const MAX_DEPTH = 8

const TS_RESERVED = new Set(
  ('break case catch class const continue debugger default delete do else enum export extends false ' +
    'finally for function if import in instanceof new null return super switch this throw true try ' +
    'typeof var void while with yield let static implements interface package private protected public ' +
    'await').split(' '),
)

const PY_RESERVED = new Set(
  ('False None True and as assert async await break class continue def del elif else except finally ' +
    'for from global if import in is lambda nonlocal not or pass raise return try while with yield ' +
    'match case type').split(' '),
)

const isObject = (value: unknown): value is Schema =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** snake_case-ish identifier valid in both Python and TS, from any MCP name. */
export function toIdentifier(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (!id) id = 'tool'
  if (/^[0-9]/.test(id)) id = `_${id}`
  if (PY_RESERVED.has(id) || TS_RESERVED.has(id)) id = `${id}_`
  return id
}

/** camelCase TS function name for a tool identifier. */
export function toTsFunctionName(identifier: string): string {
  const camel = identifier.replace(/_+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
  const safe = /^[0-9]/.test(camel) ? `_${camel}` : camel
  return TS_RESERVED.has(safe) ? `${safe}_` : safe
}

/** PascalCase type name. */
export function toTypeName(identifier: string): string {
  const fn = toTsFunctionName(identifier).replace(/_+$/, '')
  return fn.charAt(0).toUpperCase() + fn.slice(1)
}

function tsKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

function comment(text: unknown, indent: string): string {
  if (typeof text !== 'string' || !text.trim()) return ''
  const body = text.trim().replace(/\*\//g, '* /').split('\n')
  return body.length === 1
    ? `${indent}/** ${body[0]} */\n`
    : `${indent}/**\n${body.map(line => `${indent} * ${line}`).join('\n')}\n${indent} */\n`
}

/** Resolve a local `#/$defs/X` or `#/definitions/X` reference. */
function resolveRef(ref: string, root: Schema): Schema | undefined {
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  if (!match) return undefined
  const defs = root[match[1]!]
  return isObject(defs) && isObject(defs[match[2]!]) ? (defs[match[2]!] as Schema) : undefined
}

/**
 * A TS type expression for `schema`. `indent` is the indentation of the line
 * the expression starts on, so nested object literals line up.
 */
export function schemaToTs(
  schema: unknown,
  root: Schema = isObject(schema) ? schema : {},
  indent = '',
  depth = 0,
): string {
  if (!isObject(schema) || depth > MAX_DEPTH) return 'unknown'

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root)
    return target ? schemaToTs(target, root, indent, depth + 1) : 'unknown'
  }
  if ('const' in schema) return JSON.stringify(schema.const) ?? 'unknown'
  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.map(value => JSON.stringify(value)).filter(Boolean)
    return literals.length > 0 ? literals.join(' | ') : 'never'
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key])) {
      const parts = (schema[key] as unknown[]).map(part => schemaToTs(part, root, indent, depth + 1))
      return dedupe(parts).join(' | ') || 'unknown'
    }
  }
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as unknown[]).map(part => schemaToTs(part, root, indent, depth + 1))
    return dedupe(parts).map(part => (part.includes('|') ? `(${part})` : part)).join(' & ') || 'unknown'
  }

  const types = Array.isArray(schema.type)
    ? (schema.type as unknown[]).filter((t): t is string => typeof t === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : schema.properties
        ? ['object']
        : schema.items
          ? ['array']
          : []
  if (types.length === 0) return 'unknown'

  const rendered = types.map(type => {
    switch (type) {
      case 'string':
        return 'string'
      case 'number':
      case 'integer':
        return 'number'
      case 'boolean':
        return 'boolean'
      case 'null':
        return 'null'
      case 'array': {
        if (Array.isArray(schema.prefixItems)) {
          return `[${(schema.prefixItems as unknown[]).map(item => schemaToTs(item, root, indent, depth + 1)).join(', ')}]`
        }
        const item = schemaToTs(schema.items, root, indent, depth + 1)
        return /[|&\s]/.test(item) && !item.startsWith('{') ? `Array<${item}>` : `${item}[]`
      }
      case 'object':
        return objectToTs(schema, root, indent, depth)
      default:
        return 'unknown'
    }
  })
  if (schema.nullable === true && !rendered.includes('null')) rendered.push('null')
  return dedupe(rendered).join(' | ')
}

function objectToTs(schema: Schema, root: Schema, indent: string, depth: number): string {
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  )
  const inner = `${indent}  `
  const lines = Object.entries(properties).map(([key, value]) => {
    const prop = isObject(value) ? value : {}
    return (
      comment(prop.description, inner) +
      `${inner}${tsKey(key)}${required.has(key) ? '' : '?'}: ${schemaToTs(prop, root, inner, depth + 1)};`
    )
  })
  const extra = schema.additionalProperties
  if (isObject(extra)) {
    lines.push(`${inner}[key: string]: ${lines.length > 0 ? 'unknown' : schemaToTs(extra, root, inner, depth + 1)};`)
  }
  if (lines.length === 0) {
    return extra === false ? 'Record<string, never>' : 'Record<string, unknown>'
  }
  return `{\n${lines.join('\n')}\n${indent}}`
}

function dedupe(parts: string[]): string[] {
  return [...new Set(parts.filter(part => part !== 'unknown' || parts.length === 1))]
}

// ── Python ──────────────────────────────────────────────────────────

export type PyParam = {
  /** JSON property name. */
  name: string
  /** Python keyword (differs when the property name is not an identifier). */
  keyword: string
  annotation: string
  required: boolean
  description?: string
}

function pyType(schema: unknown, root: Schema, depth = 0): string {
  if (!isObject(schema) || depth > MAX_DEPTH) return 'Any'
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root)
    return target ? pyType(target, root, depth + 1) : 'Any'
  }
  if (Array.isArray(schema.enum) || 'const' in schema) {
    const values = Array.isArray(schema.enum) ? schema.enum : [schema.const]
    return `Literal[${values.map(value => pyLiteral(value)).join(', ')}]`
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key])) {
      return [...new Set((schema[key] as unknown[]).map(part => pyType(part, root, depth + 1)))].join(' | ')
    }
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  switch (type) {
    case 'string':
      return 'str'
    case 'integer':
      return 'int'
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'null':
      return 'None'
    case 'array':
      return `list[${pyType(schema.items, root, depth + 1)}]`
    case 'object':
      return 'dict[str, Any]'
    default:
      return schema.properties ? 'dict[str, Any]' : 'Any'
  }
}

function pyLiteral(value: unknown): string {
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return JSON.stringify(value)
}

/** Keyword parameters for a Python binding, or null when the schema needs **kwargs. */
export function schemaToPyParams(inputSchema: unknown): PyParam[] | null {
  const root = isObject(inputSchema) ? inputSchema : {}
  const properties = isObject(root.properties) ? root.properties : {}
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((r): r is string => typeof r === 'string') : [],
  )
  const params: PyParam[] = []
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(properties)) {
    const keyword = toIdentifier(name)
    // A name that had to be rewritten cannot round-trip as a keyword; fall
    // back to **kwargs rather than guess which JSON key was meant.
    if (keyword !== name || seen.has(keyword)) return null
    seen.add(keyword)
    const prop = isObject(value) ? value : {}
    params.push({
      name,
      keyword,
      annotation: pyType(prop, root),
      required: required.has(name),
      description: typeof prop.description === 'string' ? prop.description : undefined,
    })
  }
  // Required first: Python forbids a default before a non-default, even
  // keyword-only, only for positionals — but ordering reads better anyway.
  return [...params.filter(p => p.required), ...params.filter(p => !p.required)]
}

/** One line per property, for a docstring: `name (type, required): description`. */
export function schemaSummaryLines(schema: unknown): string[] {
  const root = isObject(schema) ? schema : {}
  const properties = isObject(root.properties) ? root.properties : {}
  const required = new Set(Array.isArray(root.required) ? root.required : [])
  return Object.entries(properties).map(([name, value]) => {
    const prop = isObject(value) ? value : {}
    const description = typeof prop.description === 'string' ? `: ${prop.description.split('\n')[0]}` : ''
    return `${name} (${pyType(prop, root)}${required.has(name) ? ', required' : ''})${description}`
  })
}
