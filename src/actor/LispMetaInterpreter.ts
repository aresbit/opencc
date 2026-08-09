import type { ActorRuntime } from './ActorRuntime.js'

type LispSymbol = { type: 'symbol'; name: string }
type LispList = LispValue[]
export type LispValue =
  | null
  | boolean
  | number
  | string
  | LispSymbol
  | LispList
  | Record<string, unknown>
  | LispFunction
type LispFunction = (...args: LispValue[]) => LispValue | Promise<LispValue>

class Environment {
  private readonly values = new Map<string, LispValue>()
  constructor(private readonly parent?: Environment) {}

  define(name: string, value: LispValue): LispValue {
    this.values.set(name, value)
    return value
  }

  get(name: string): LispValue {
    if (this.values.has(name)) return this.values.get(name)!
    if (this.parent) return this.parent.get(name)
    throw new Error(`Unbound Lisp symbol: ${name}`)
  }

  set(name: string, value: LispValue): LispValue {
    if (this.values.has(name)) {
      this.values.set(name, value)
      return value
    }
    if (this.parent) return this.parent.set(name, value)
    throw new Error(`Cannot set unbound Lisp symbol: ${name}`)
  }
}

function symbol(name: string): LispSymbol {
  return { type: 'symbol', name }
}

function isSymbol(value: LispValue, name?: string): value is LispSymbol {
  return (
    Boolean(value) &&
    !Array.isArray(value) &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'symbol' &&
    (name === undefined || value.name === name)
  )
}

function tokenize(source: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (char === ';') {
      while (index < source.length && source[index] !== '\n') index++
      continue
    }
    if (char === '(' || char === ')' || char === "'") {
      tokens.push(char)
      index++
      continue
    }
    if (char === '"') {
      let token = '"'
      index++
      let escaped = false
      while (index < source.length) {
        const next = source[index++]!
        token += next
        if (!escaped && next === '"') break
        escaped = !escaped && next === '\\'
        if (next !== '\\') escaped = false
      }
      if (!token.endsWith('"') || token === '"') {
        throw new Error('Unterminated Lisp string')
      }
      tokens.push(token)
      continue
    }
    const start = index
    while (index < source.length && !/[\s()']/.test(source[index]!)) {
      index++
    }
    tokens.push(source.slice(start, index))
  }
  return tokens
}

function atom(token: string): LispValue {
  if (token.startsWith('"')) return JSON.parse(token)
  if (token === '#t' || token === 'true') return true
  if (token === '#f' || token === 'false') return false
  if (token === 'nil' || token === 'null') return null
  const number = Number(token)
  return token !== '' && Number.isFinite(number) ? number : symbol(token)
}

export function parseLisp(source: string): LispValue[] {
  const tokens = tokenize(source)
  let index = 0
  const read = (): LispValue => {
    const token = tokens[index++]
    if (token === undefined) throw new Error('Unexpected end of Lisp input')
    if (token === ')') throw new Error('Unexpected )')
    if (token === "'") return [symbol('quote'), read()]
    if (token !== '(') return atom(token)
    const list: LispList = []
    while (tokens[index] !== ')') {
      if (index >= tokens.length) throw new Error('Missing )')
      list.push(read())
    }
    index++
    return list
  }
  const expressions: LispValue[] = []
  while (index < tokens.length) expressions.push(read())
  return expressions
}

function truthy(value: LispValue): boolean {
  return value !== false && value !== null
}

function requireNumber(value: LispValue): number {
  if (typeof value !== 'number') throw new Error('Expected number')
  return value
}

function requireList(value: LispValue): LispList {
  if (!Array.isArray(value)) throw new Error('Expected list')
  return value
}

function quoted(value: LispValue): LispValue {
  if (isSymbol(value)) return value.name
  if (Array.isArray(value)) return value.map(quoted)
  return value
}

export class LispMetaInterpreter {
  private readonly global = new Environment()
  private steps = 0

  constructor(
    readonly actor: ActorRuntime,
    private readonly maxSteps = 10_000,
  ) {
    const numeric =
      (fn: (...values: number[]) => number): LispFunction =>
      (...args) =>
        fn(...args.map(requireNumber))
    this.global.define(
      '+',
      numeric((...values) => values.reduce((a, b) => a + b, 0)),
    )
    this.global.define(
      '-',
      numeric((first, ...rest) => rest.reduce((a, b) => a - b, first)),
    )
    this.global.define(
      '*',
      numeric((...values) => values.reduce((a, b) => a * b, 1)),
    )
    this.global.define(
      '/',
      numeric((first, ...rest) => rest.reduce((a, b) => a / b, first)),
    )
    this.global.define('=', (...args) =>
      args.every(value => Object.is(value, args[0])),
    )
    this.global.define('<', (a, b) => requireNumber(a) < requireNumber(b))
    this.global.define('>', (a, b) => requireNumber(a) > requireNumber(b))
    this.global.define('not', value => !truthy(value))
    this.global.define('list', (...args) => args)
    this.global.define('car', value => requireList(value)[0] ?? null)
    this.global.define('cdr', value => requireList(value).slice(1))
    this.global.define('cons', (head, tail) => [head, ...requireList(tail)])
    this.global.define('length', value => requireList(value).length)
    this.global.define('json', value => JSON.stringify(value))
    this.global.define('self', actor.self)
    this.global.define('tx', async (to, payload, kind = 'message') => {
      if (typeof to !== 'string' || typeof kind !== 'string') {
        throw new Error('tx expects (tx address payload [kind])')
      }
      return (await actor.tx(to, quoted(payload), {
        kind,
      })) as unknown as Record<string, unknown>
    })
    this.global.define(
      'rx',
      async (timeoutMs = 0, limit = 1) =>
        (await actor.rx({
          timeoutMs: requireNumber(timeoutMs),
          limit: requireNumber(limit),
        })) as unknown as LispValue,
    )
  }

  async evaluate(source: string): Promise<LispValue> {
    this.steps = 0
    let result: LispValue = null
    for (const expression of parseLisp(source)) {
      result = await this.evalExpression(expression, this.global)
    }
    return result
  }

  private async evalExpression(
    expression: LispValue,
    environment: Environment,
  ): Promise<LispValue> {
    this.steps++
    if (this.steps > this.maxSteps)
      throw new Error('Lisp evaluation step limit exceeded')
    if (isSymbol(expression)) return environment.get(expression.name)
    if (!Array.isArray(expression)) return expression
    if (expression.length === 0) return []

    const [head, ...tail] = expression
    if (isSymbol(head, 'quote')) return quoted(tail[0] ?? null)
    if (isSymbol(head, 'if')) {
      return this.evalExpression(
        truthy(await this.evalExpression(tail[0] ?? null, environment))
          ? (tail[1] ?? null)
          : (tail[2] ?? null),
        environment,
      )
    }
    if (isSymbol(head, 'begin')) {
      let result: LispValue = null
      for (const item of tail)
        result = await this.evalExpression(item, environment)
      return result
    }
    if (isSymbol(head, 'define') || isSymbol(head, 'set!')) {
      const name = tail[0]
      if (!isSymbol(name)) throw new Error(`${head.name} expects a symbol`)
      const value = await this.evalExpression(tail[1] ?? null, environment)
      return head.name === 'define'
        ? environment.define(name.name, value)
        : environment.set(name.name, value)
    }
    if (isSymbol(head, 'lambda')) {
      const parameters = requireList(tail[0] ?? null)
      if (!parameters.every(value => isSymbol(value))) {
        throw new Error('lambda parameters must be symbols')
      }
      const body = tail.slice(1)
      return async (...args: LispValue[]) => {
        const local = new Environment(environment)
        parameters.forEach((parameter, index) =>
          local.define((parameter as LispSymbol).name, args[index] ?? null),
        )
        let result: LispValue = null
        for (const item of body) result = await this.evalExpression(item, local)
        return result
      }
    }
    if (isSymbol(head, 'let')) {
      const local = new Environment(environment)
      for (const binding of requireList(tail[0] ?? null)) {
        const pair = requireList(binding)
        if (!isSymbol(pair[0])) throw new Error('let binding needs a symbol')
        local.define(
          pair[0].name,
          await this.evalExpression(pair[1] ?? null, environment),
        )
      }
      let result: LispValue = null
      for (const item of tail.slice(1))
        result = await this.evalExpression(item, local)
      return result
    }

    const callable = await this.evalExpression(head ?? null, environment)
    if (typeof callable !== 'function')
      throw new Error('First list item is not callable')
    const args = await Promise.all(
      tail.map(item => this.evalExpression(item, environment)),
    )
    return callable(...args)
  }
}
