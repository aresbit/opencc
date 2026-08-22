import partition from 'lodash-es/partition.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isMcpTool } from '../services/mcp/utils.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'

/**
 * Compatibility seam retained for callers compiled against the old API.
 * MateBot coordinators now keep the complete ordinary tool pool; delegation
 * is a model decision rather than an allowlist enforced here.
 */
export function applyCoordinatorToolFilter(tools: Tools): Tools {
  return tools
}

/**
 * Pure function that merges tool pools.
 *
 * Lives in a React-free file so print.ts can import it without pulling
 * react/ink into the SDK module graph. The useMergedTools hook delegates
 * to this function inside useMemo.
 *
 * @param initialTools - Extra tools to include (built-in + startup MCP from props).
 * @param assembled - Tools from assembleToolPool (built-in + MCP, deduped).
 * @param _mode - The permission context mode, retained for API compatibility.
 * @returns Merged and deduplicated tool array.
 */
export function mergeAndFilterTools(
  initialTools: Tools,
  assembled: Tools,
  _mode: ToolPermissionContext['mode'],
): Tools {
  // Merge initialTools on top - they take precedence in deduplication.
  // initialTools may include built-in tools (from getTools() in REPL.tsx) which
  // overlap with assembled tools. uniqBy handles this deduplication.
  // Partition-sort for prompt-cache stability (same as assembleToolPool):
  // built-ins must stay a contiguous prefix for the server's cache policy.
  const [mcp, builtIn] = partition(
    uniqBy([...initialTools, ...assembled], 'name'),
    isMcpTool,
  )
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return [...builtIn.sort(byName), ...mcp.sort(byName)]
}
