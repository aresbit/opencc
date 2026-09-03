import { relative } from 'node:path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import type { InputSchema, OutputSchema } from '../../Tool.js'
import { AstGrepUnavailableError } from '../../services/astgrep/runtime.js'
import { SUPPORTED_LANGUAGES } from '../../services/astgrep/languages.js'
import { searchTree, type Match } from '../../services/astgrep/search.js'
import { getCwd } from '../../utils/cwd.js'
import { expandPath } from '../../utils/path.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { AST_GREP_TOOL_NAME, DESCRIPTION, getPrompt } from './prompt.js'

const MAX_RESULT_CHARS = 30_000
const DEFAULT_LIMIT = 100

const inputSchemaShape = z.object({
  pattern: z
    .string()
    .min(1)
    .optional()
    .describe('Code shape to find, with $NAME / $$$NAME metavariables'),
  kind: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Match by AST node kind (e.g. function_declaration, class_declaration, call_expression). Use this for "every X" questions — a bare pattern is stricter than it looks. Combines with pattern.',
    ),
  path: z.string().optional().describe('File or directory to search (default: cwd)'),
  language: z
    .enum(SUPPORTED_LANGUAGES as [string, ...string[]])
    .optional()
    .describe('Force a language instead of inferring one per file from its extension'),
  glob: z.string().optional().describe('Narrow the file set, e.g. "**/*.ts"'),
  head_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Maximum matches to return (default ${DEFAULT_LIMIT})`),
})

export type Input = z.infer<typeof inputSchemaShape>

export type Output = {
  ok: boolean
  report: string
  matches?: Match[]
  files_scanned?: number
  truncated?: boolean
}

const inputSchema = lazySchema(() => inputSchemaShape)
const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    report: z.string(),
    matches: z.array(z.unknown()).optional(),
    files_scanned: z.number().optional(),
    truncated: z.boolean().optional(),
  }),
)

/**
 * One match per line, file:line first so the path is clickable, then the
 * matched source indented under it. Captures are printed only when the pattern
 * has metavariables — for a pattern with none they would be an empty line of
 * noise on every hit.
 */
function render(
  pattern: string,
  outcome: Awaited<ReturnType<typeof searchTree>>,
  root: string,
): string {
  const lines: string[] = []
  if (outcome.invalidPattern) {
    // Never let this read as "there are none of these in your codebase".
    return [
      `The pattern was not searched: ${outcome.invalidPattern}`,
      '',
      `  ${pattern}`,
      '',
      'A pattern has to parse as a standalone fragment of the language. If you want "every X" rather than one exact shape, pass `kind` instead — e.g. kind: "function_declaration".',
    ].join('\n')
  }
  if (outcome.matches.length === 0) {
    lines.push(`No matches for  ${pattern}`)
    if (outcome.filesScanned === 0) {
      lines.push('')
      lines.push(
        outcome.filesSkipped > 0
          ? `Nothing was parsed: ${outcome.filesSkipped} file(s) matched the path but none have a grammar here. Supported: ${SUPPORTED_LANGUAGES.join(', ')}.`
          : 'No files matched the path or glob.',
      )
    } else {
      lines.push('')
      lines.push(
        `Parsed ${outcome.filesScanned} file(s). If this is unexpected, check that the pattern parses on its own — a fragment the language cannot parse matches nothing.`,
      )
    }
  } else {
    for (const m of outcome.matches) {
      const where = `${relative(root, m.file) || m.file}:${m.line}`
      const body = m.text.split('\n')
      lines.push(where)
      for (const l of body.slice(0, 12)) lines.push(`    ${l}`)
      if (body.length > 12) lines.push(`    … ${body.length - 12} more line(s)`)
      const captures = Object.entries(m.captures)
      if (captures.length > 0) {
        lines.push(
          `    ⟵ ${captures.map(([k, v]) => `${k}=${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v)}`).join('  ')}`,
        )
      }
      lines.push('')
    }
    lines.push(
      `${outcome.matches.length} match(es) in ${outcome.filesScanned} file(s) parsed.`,
    )
  }

  if (outcome.truncated) {
    lines.push('Result truncated — raise head_limit or narrow the path/glob.')
  }
  if (outcome.failures.length > 0) {
    lines.push('')
    lines.push('Not searched:')
    for (const f of outcome.failures.slice(0, 5)) {
      lines.push(`  ${relative(root, f.file) || f.file}: ${f.reason}`)
    }
    if (outcome.failures.length > 5) {
      lines.push(`  … and ${outcome.failures.length - 5} more`)
    }
  }
  return lines.join('\n')
}

export const AstGrepTool = buildTool({
  name: AST_GREP_TOOL_NAME,
  aliases: ['AstGrepTool', 'astgrep', 'sg'],
  searchHint:
    'find code by syntax rather than text — every call to a function however its arguments are wrapped, empty catch blocks, a class that extends something',
  shouldDefer: false,
  maxResultSizeChars: MAX_RESULT_CHARS,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'AstGrep'
  },
  isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  renderToolUseMessage(input: Input) {
    const where = input.path ? ` in ${input.path}` : ''
    const what = input.pattern ?? `kind:${input.kind}`
    return `${what}${where}`
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return { tool_use_id: toolUseId, type: 'tool_result' as const, content: output.report }
  },
  async call(input: Input, context: { abortController?: AbortController }) {
    const root = getCwd()
    const target = input.path ? expandPath(input.path) : root
    const signal = context?.abortController?.signal ?? new AbortController().signal

    try {
      if (!input.pattern && !input.kind) {
        return {
          data: {
            ok: false,
            report: 'ast_grep needs a pattern, a kind, or both.',
          } satisfies Output,
        }
      }
      const outcome = await searchTree({
        pattern: input.pattern,
        kind: input.kind,
        target,
        language: input.language,
        globs: input.glob ? [input.glob] : [],
        limit: input.head_limit ?? DEFAULT_LIMIT,
        signal,
      })
      return {
        data: {
          ok: true,
          report: render(input.pattern ?? `kind: ${input.kind}`, outcome, root),
          matches: outcome.matches,
          files_scanned: outcome.filesScanned,
          truncated: outcome.truncated,
        } satisfies Output,
      }
    } catch (error) {
      // An unavailable runtime and a bad pattern are different problems and the
      // model can act on the difference: one means "use Grep instead", the
      // other means "fix the pattern".
      const message =
        error instanceof AstGrepUnavailableError
          ? `Structural search is unavailable: ${error.message}`
          : `ast-grep failed: ${(error as Error).message}`
      return { data: { ok: false, report: message } satisfies Output }
    }
  },
})
