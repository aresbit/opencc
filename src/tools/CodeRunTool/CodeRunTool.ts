/**
 * CodeRun — collapse N tool-call round-trips into 1.
 *
 * The model writes a JavaScript code block that calls $.tool.<Name>(input)
 * to invoke real tools. All calls go through the actual tool system with
 * full hook chain coverage (cache, taint, retry, etc.).
 *
 * Unlike CodeAct (which runs code in an external sandbox with filesystem
 * builtins), CodeRun executes in-process with direct access to the tool
 * table. Its purpose is orchestration, not general computation.
 *
 * $.tool.<Name>(input)  — call any registered tool
 * $.recipe.<name>(params) — call a JIT-synthesized recipe
 * Promise.all(...)       — parallel fan-out, no extra round-trips
 */

import { z } from 'zod/v4'
import { buildTool, findToolByName, type ToolDef, type Tools, type ToolUseContext, type CanUseToolFn } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CODE_RUN_TOOL_NAME } from './toolName.js'

export { CODE_RUN_TOOL_NAME }

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe(
      'JavaScript code to execute. Access tools via $.tool.<ToolName>(input). ' +
      'Access JIT-synthesized recipes via $.recipe.<name>(params). ' +
      'Use Promise.all() for parallel execution. The return value is the result.',
    ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

interface CallLogEntry {
  tool: string
  elapsed: number
  ok: boolean
}

/**
 * Create the $ proxy object that code runs against.
 *
 * $.tool.<Name>(input) dispatches to the real tool by looking it up
 * in the tool list, parsing input through its Zod schema, and calling
 * tool.call(). The result is unwrapped (ToolResult.data) so the code
 * sees plain values, not framework wrappers.
 */
export function createToolProxy(
  tools: Tools,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
) {
  const callLog: CallLogEntry[] = []

  const toolProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
    get(_, toolName: string) {
      return async (input: Record<string, unknown> = {}) => {
        const tool = findToolByName(tools, toolName)
        if (!tool) throw new Error(`Tool "${toolName}" not available`)

        const parsed = tool.inputSchema.safeParse(input)
        if (!parsed.success) {
          throw new Error(`Invalid input for ${toolName}: ${(parsed as any).error}`)
        }

        const start = Date.now()
        try {
          const result = await tool.call(parsed.data, context, canUseTool, parentMessage)
          callLog.push({ tool: toolName, elapsed: Date.now() - start, ok: true })
          return result.data
        } catch (err) {
          callLog.push({ tool: toolName, elapsed: Date.now() - start, ok: false })
          throw err
        }
      }
    },
  })

  // Lazy-load recipe proxy to avoid hard dependency on jitSynthesisHook
  let _recipeProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getRecipeProxy() {
    if (_recipeProxy) return _recipeProxy
    _recipeProxy = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
      get(_, recipeName: string) {
        return async (params: Record<string, unknown> = {}) => {
          let recipes: Array<{ name: string; codeTemplate: string }>
          try {
            const mod = await import('../../services/functionHooks/plugins/jitSynthesisHook.js')
            recipes = mod.getSyntheticRecipes()
          } catch {
            throw new Error('JIT synthesis not available')
          }
          const recipe = recipes.find(r => r.name === recipeName)
          if (!recipe) {
            const available = recipes.map(r => r.name).join(', ') || 'none'
            throw new Error(`Recipe "${recipeName}" not found. Available: ${available}`)
          }
          const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
          const fn = new AsyncFn('$', 'params', `"use strict";\n${recipe.codeTemplate}`)
          return await fn({ tool: toolProxy, recipe: getRecipeProxy() }, params)
        }
      },
    })
    return _recipeProxy
  }

  // Lazy-load TUI proxy for runtime view registration
  let _tuiProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getTuiProxy() {
    if (_tuiProxy) return _tuiProxy
    _tuiProxy = {
      async registerView(view: unknown) {
        const { registerView } = await import('../../services/tuiRegistry/registry.js')
        registerView(view as any)
        return { registered: (view as any).id }
      },
      async configure(agentId: string, config: unknown) {
        const { setAgentTuiConfig } = await import('../../services/tuiRegistry/registry.js')
        setAgentTuiConfig(agentId, config as any)
        return { configured: agentId }
      },
    }
    return _tuiProxy
  }

  // Lazy-load plain language proxy for readability analysis and config
  let _plainLanguageProxy: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null
  function getPlainLanguageProxy() {
    if (_plainLanguageProxy) return _plainLanguageProxy
    _plainLanguageProxy = {
      async analyze(text: unknown) {
        const { analyzeText } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        return analyzeText(String(text))
      },
      async configure(cfg: unknown) {
        const { setConfig } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        setConfig(cfg as any)
        return { configured: true }
      },
      async enable() {
        const { enable } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        enable()
        return { enabled: true }
      },
      async disable() {
        const { disable } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        disable()
        return { enabled: false }
      },
      async stats() {
        const { getStats } = await import('../../services/functionHooks/plugins/plainLanguageHook.js')
        return getStats()
      },
    }
    return _plainLanguageProxy
  }

  return {
    tool: toolProxy,
    get recipe() { return getRecipeProxy() },
    get tui() { return getTuiProxy() },
    get plainLanguage() { return getPlainLanguageProxy() },
    _callLog: callLog,
  }
}

export const CodeRunTool = buildTool({
  name: CODE_RUN_TOOL_NAME,
  searchHint: 'execute orchestrate parallel tools batch loop aggregate',
  maxResultSizeChars: 200_000,

  async description() {
    return (
      'Execute a code block that orchestrates multiple tool calls via ' +
      '$.tool.<Name>(input). Collapses N sequential round-trips into 1. ' +
      'Supports Promise.all for parallelism, loops, conditionals, and aggregation.'
    )
  },

  async prompt() {
    return `## CodeRun — orchestrate tools in one round-trip

Execute a JavaScript code block with direct access to the tool table.

### API

\`$.tool.<ToolName>(input)\` — call any registered tool. Returns the tool's
result data directly (unwrapped). Input is validated against the tool's schema.

\`$.recipe.<name>(params)\` — call a JIT-synthesized recipe (a pre-built
multi-tool sequence detected from your usage patterns).

\`$.tui.registerView(viewDef)\` — register a custom TUI view for agent progress.
\`$.tui.configure(agentId, config)\` — set TUI config for an agent.

\`$.plainLanguage.analyze(text)\` — score text readability (Flesch-Kincaid grade, sentence length, passive voice ratio).
\`$.plainLanguage.configure(config)\` — adjust plain language settings (targetGradeLevel, injectMode, etc.).
\`$.plainLanguage.enable()\` / \`$.plainLanguage.disable()\` — toggle ISO 24495 prompt enhancement.
\`$.plainLanguage.stats()\` — get session readability statistics.

### When to use CodeRun

- **Parallel fan-out**: scan 100 files for a pattern in one call
- **Conditional pipelines**: read a file, decide what to do, act
- **Aggregation**: collect results from many tools, filter, summarize
- **Loops**: iterate over a list with tool calls per item

### Examples

Search all TypeScript files for TODOs:
\`\`\`javascript
const files = await $.tool.Glob({ pattern: "src/**/*.ts" });
const hits = await Promise.all(
  files.map(f => $.tool.Grep({ pattern: "TODO", path: f }))
);
return hits.filter(h => h && h.length > 0);
\`\`\`

Read a file, check for issues, fix them:
\`\`\`javascript
const content = await $.tool.Read({ file_path: "src/config.ts" });
if (content.includes("localhost")) {
  await $.tool.Edit({
    file_path: "src/config.ts",
    old_string: "localhost",
    new_string: "0.0.0.0",
  });
  return "Fixed hardcoded localhost";
}
return "No issues found";
\`\`\`

### Notes

- The code runs in an async context — use \`await\` for tool calls
- Return the final result; it becomes the tool output
- Errors in tool calls propagate as exceptions
- All tool calls go through the full hook chain (cache, retry, etc.)
- For general computation (data analysis, ML, plots), use CodeAct instead`
  },

  get inputSchema() { return inputSchema() },

  isConcurrencySafe() { return false },
  isReadOnly() { return false },

  renderToolUseMessage() { return null },

  async call({ code }, context, canUseTool, parentMessage) {
    const $ = createToolProxy(context.options.tools, context, canUseTool, parentMessage)

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

    const startTime = Date.now()
    try {
      const fn = new AsyncFunction('$', `"use strict";\n${code}`)
      const result = await fn($)
      const elapsed = Date.now() - startTime

      return {
        data: {
          success: true,
          result,
          toolCalls: $._callLog.length,
          callLog: $._callLog,
          elapsed,
        },
      }
    } catch (err) {
      const elapsed = Date.now() - startTime
      return {
        data: {
          success: false,
          error: String(err),
          toolCalls: $._callLog.length,
          callLog: $._callLog,
          elapsed,
        },
      }
    }
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as {
      success: boolean
      result?: unknown
      error?: string
      toolCalls: number
      callLog: CallLogEntry[]
      elapsed: number
    }

    const parts: string[] = []

    // Header
    const status = out.success ? 'OK' : 'FAILED'
    parts.push(`[CodeRun ${status}: ${out.toolCalls} tool calls in ${out.elapsed}ms]`)

    // Call log summary
    if (out.callLog.length > 0) {
      const summary = out.callLog
        .map(c => `  ${c.ok ? '✓' : '✗'} ${c.tool} (${c.elapsed}ms)`)
        .join('\n')
      parts.push(summary)
    }

    // Result or error
    if (out.error) {
      parts.push(`\nError: ${out.error}`)
    } else {
      const resultStr =
        typeof out.result === 'string'
          ? out.result
          : out.result === undefined
            ? 'undefined'
            : JSON.stringify(out.result, null, 2)
      parts.push(`\n${resultStr}`)
    }

    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: parts.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, { success: boolean; result?: unknown; error?: string; toolCalls: number; callLog: CallLogEntry[]; elapsed: number }>)
