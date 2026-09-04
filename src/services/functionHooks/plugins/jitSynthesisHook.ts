/**
 * JIT Tool Synthesis — the tool set evolves from usage.
 *
 * Observes tool.call sequences. When a subsequence of 3+ tools repeats
 * 3+ times, it is crystallized into a named recipe and optionally a
 * synthetic Tool registered in the tool table.
 *
 * Recipes are accessible two ways:
 *   1. $.recipe.<name>(params) inside CodeRun code blocks
 *   2. As standalone tools via getSyntheticTools() → tool registry
 *
 * The synthesis loop runs every DETECTION_INTERVAL calls, keeping
 * overhead negligible during normal operation.
 */

import { z } from 'zod/v4'
import { buildTool, findToolByName, type Tool, type ToolUseContext, type CanUseToolFn } from '../../../Tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { OnRegistrar } from '../types.js'

// ─── Recipe types ────────────────────────────────────────────────────

export interface Recipe {
  name: string
  tools: string[]
  codeTemplate: string
  paramNames: string[]
  description: string
  occurrences: number
  firstSeen: number
}

// ─── State ───────────────────────────────────────────────────────────

const toolHistory: string[] = []
const recipes = new Map<string, Recipe>()
const MAX_HISTORY = 300
const MIN_SEQ_LEN = 3
const MAX_SEQ_LEN = 6
const MIN_OCCURRENCES = 3
const DETECTION_INTERVAL = 15

let callCount = 0

// ─── Known chaining patterns ────────────────────────────────────────
//
// When tool A's output naturally feeds into tool B's input, we can
// generate smarter code templates instead of generic step-by-step.

const CHAIN_RULES: Record<string, Record<string, string>> = {
  // Glob outputs file paths → fan-out to Grep/Read
  Glob: {
    Grep:  'await Promise.all(prev.map(f => $.tool.Grep({ pattern: params.pattern || "", path: f })))',
    Read:  'await Promise.all(prev.slice(0, 10).map(f => $.tool.Read({ file_path: f })))',
    Edit:  'await $.tool.Edit({ file_path: prev[0], ...params.edit })',
  },
  // Grep outputs match info → Read the matched files
  Grep: {
    Read: 'await Promise.all((Array.isArray(prev) ? prev.flat() : [prev]).slice(0, 10).map(f => $.tool.Read({ file_path: typeof f === "string" ? f.split(":")[0] : f })))',
  },
  // Read outputs content → Edit the same file
  Read: {
    Edit: 'await $.tool.Edit({ file_path: params.file_path, ...params.edit })',
  },
}

// ─── Pattern detection ───────────────────────────────────────────────

function detectPatterns(): void {
  if (toolHistory.length < MIN_SEQ_LEN * MIN_OCCURRENCES) return

  const freq = new Map<string, number>()

  for (let len = MIN_SEQ_LEN; len <= Math.min(MAX_SEQ_LEN, toolHistory.length); len++) {
    for (let i = 0; i <= toolHistory.length - len; i++) {
      const key = toolHistory.slice(i, i + len).join('→')
      freq.set(key, (freq.get(key) ?? 0) + 1)
    }
  }

  for (const [key, count] of freq) {
    if (count < MIN_OCCURRENCES) continue
    if (recipes.has(key)) {
      recipes.get(key)!.occurrences = count
      continue
    }

    const tools = key.split('→')
    const name = tools.map(t => t.toLowerCase()).join('_')
    const { code, params } = generateTemplate(tools)

    recipes.set(key, {
      name,
      tools,
      codeTemplate: code,
      paramNames: params,
      description: `JIT-synthesized: ${tools.join(' → ')} (detected ${count}× in this session)`,
      occurrences: count,
      firstSeen: Date.now(),
    })
  }
}

// ─── Code template generation ────────────────────────────────────────

function generateTemplate(tools: string[]): { code: string; params: string[] } {
  const lines: string[] = []
  const params: string[] = []

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    const prev = i > 0 ? tools[i - 1] : null

    // Check for known chaining rule
    const chainExpr = prev && CHAIN_RULES[prev]?.[tool]

    if (chainExpr) {
      lines.push(`const r${i} = ${chainExpr.replace(/prev/g, `r${i - 1}`)};`)
    } else if (i === 0) {
      const paramName = `${tool.toLowerCase()}_input`
      params.push(paramName)
      lines.push(`const r${i} = await $.tool.${tool}(params.${paramName} || {});`)
    } else {
      const paramName = `${tool.toLowerCase()}_input`
      params.push(paramName)
      lines.push(`const r${i} = await $.tool.${tool}({ ...params.${paramName}, _prev: r${i - 1} });`)
    }
  }

  lines.push(`return r${tools.length - 1};`)

  // Collect params referenced by chain rules
  const codeStr = lines.join('\n')
  if (codeStr.includes('params.pattern') && !params.includes('pattern')) params.push('pattern')
  if (codeStr.includes('params.file_path') && !params.includes('file_path')) params.push('file_path')
  if (codeStr.includes('params.edit') && !params.includes('edit')) params.push('edit')

  return { code: codeStr, params }
}

// ─── Synthetic tool factory ──────────────────────────────────────────

function createSyntheticTool(recipe: Recipe): Tool {
  const schemaFields: Record<string, z.ZodType> = {}
  for (const param of recipe.paramNames) {
    schemaFields[param] = z.unknown().optional()
  }

  return buildTool({
    name: `jit_${recipe.name}`,
    searchHint: `synthesized ${recipe.tools.join(' ')} composite`,
    shouldDefer: true,
    maxResultSizeChars: 100_000,

    async description() { return recipe.description },
    async prompt() { return recipe.description },

    get inputSchema() {
      return z.object(schemaFields) as any
    },

    renderToolUseMessage() { return null },

    async call(input: Record<string, unknown>, context: ToolUseContext, canUseTool: CanUseToolFn, parentMessage: AssistantMessage) {
      // Build a minimal tool proxy for recipe execution
      const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
      const proxyHandler = {
        get(_: unknown, toolName: string) {
          return async (toolInput: Record<string, unknown> = {}) => {
            const tool = findToolByName(context.options.tools, toolName)
            if (!tool) throw new Error(`Tool "${toolName}" not available`)
            const parsed = tool.inputSchema.safeParse(toolInput)
            if (!parsed.success) throw new Error(`Invalid input for ${toolName}`)
            const result = await tool.call(parsed.data, context, canUseTool, parentMessage)
            return result.data
          }
        },
      }
      const toolProxy = new Proxy(proxy, proxyHandler)
      const $ = { tool: toolProxy }

      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      const fn = new AsyncFunction('$', 'params', `"use strict";\n${recipe.codeTemplate}`)

      const result = await fn($, input)
      return { data: result }
    },

    mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string) {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) ?? 'null',
      }
    },
  } as any) as Tool
}

// ─── Hook registration ───────────────────────────────────────────────

export function register(on: OnRegistrar): void {
  on('tool.call', async ($, e: any, next) => {
    const tool = e.tool as string
    if (tool && tool !== 'CodeRun' && !tool.startsWith('jit_')) {
      toolHistory.push(tool)
      if (toolHistory.length > MAX_HISTORY) toolHistory.shift()

      callCount++
      if (callCount % DETECTION_INTERVAL === 0) {
        detectPatterns()
      }
    }
    return next(e)
  })
}

// ─── Public API ──────────────────────────────────────────────────────

export function getSyntheticRecipes(): Recipe[] {
  return [...recipes.values()]
}

export function getSyntheticTools(): Tool[] {
  return [...recipes.values()].map(createSyntheticTool)
}

export function getRecipeCount(): number {
  return recipes.size
}

export function getToolHistory(): readonly string[] {
  return toolHistory
}

export function clearSynthesis(): void {
  toolHistory.length = 0
  recipes.clear()
  callCount = 0
}
