/**
 * Bridge: connect algebraic-effect hooks to the existing hook execution path.
 *
 * When a PascalCase hook event fires (e.g. PreToolUse), the bridge:
 * 1. Maps it to the dot-notation event (tool.call) via REVERSE_ALIASES
 * 2. Dispatches through the algebraic-effect chain
 * 3. Converts the chain result back to AggregatedHookResult format
 *
 * The engine ($) is built once at startup and frozen; subsequent calls
 * to initEngine() are no-ops.
 */

import type { HookEvent, HookInput } from 'src/entrypoints/agentSdkTypes.js'
import type { AggregatedHookResult } from 'src/utils/hooks.js'
import { findToolByName, type Tools } from 'src/Tool.js'
import { dispatch, HookChainBottomError } from './dispatcher.js'
import { buildEngineInterface, buildCoreNouns } from './engine.js'
import { registry } from './registry.js'
import { REVERSE_ALIASES, isDenyResult, type EngineInterface, type FunctionHookEvent, type HookFn } from './types.js'
import { registerBuiltinPlugins, resetBuiltinPlugins } from './plugins/index.js'
import { logError } from 'src/utils/log.js'

let engineInterface: EngineInterface | null = null
let engineInitPromise: Promise<EngineInterface> | null = null

/**
 * Initialize the engine interface ($). Safe to call multiple times —
 * the first call builds $, subsequent calls return the cached instance.
 *
 * Registers built-in plugins (cache, compress, writeGuard, retry,
 * autoPermit, knowledge) before building the engine so their hooks
 * are in the chain from the first dispatch.
 */
export async function initEngine(): Promise<EngineInterface> {
  if (engineInterface) return engineInterface
  if (engineInitPromise) return engineInitPromise

  registerBuiltinPlugins()

  engineInitPromise = buildEngineInterface(buildCoreNouns()).then(iface => {
    engineInterface = iface
    return iface
  })

  return engineInitPromise
}

/**
 * Get the engine interface if already initialized.
 */
export function getEngine(): EngineInterface | null {
  return engineInterface
}

/**
 * Reset the engine (for testing or hot-reload).
 */
export function resetEngine(): void {
  engineInterface = null
  engineInitPromise = null
  resetBuiltinPlugins()
  registry.clear()
}

/**
 * Check whether any algebraic-effect hooks are registered for a given
 * PascalCase hook event.
 */
export function hasAlgebraicHooksForEvent(hookEvent: HookEvent): boolean {
  const dotEvent = REVERSE_ALIASES[hookEvent]
  if (!dotEvent) return false

  const hooks = registry.getForEvent(dotEvent)
  return hooks.length > 0
}

/**
 * Dispatch a PascalCase hook event through the algebraic-effect chain
 * and yield results in the existing AggregatedHookResult format.
 *
 * This is called from executeHooks() after the existing hook types
 * have been processed. The algebraic-effect hooks run as a separate
 * dispatch — they don't share the parallel execution with command/
 * callback hooks, but their results feed into the same aggregation.
 */
export async function* dispatchAlgebraicHooks(
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools,
): AsyncGenerator<AggregatedHookResult> {
  const dotEvent = REVERSE_ALIASES[hookEvent] as FunctionHookEvent | undefined
  if (!dotEvent) return

  const hooks = registry.getForEvent(dotEvent)
  if (hooks.length === 0) return

  const $ = engineInterface
  if (!$) return

  // MCP server identity lives on the Tool object (mcpInfo.serverName), not
  // on the hookInput — PreToolUse/PostToolUse/PostToolUseFailure only ever
  // carry tool_name/tool_input, no matter which server the tool came from.
  // A broker matching on server identity (e.g. on('tool.call',
  // {mcpServer: 'ida'}, ...)) needs that looked up and attached here, once,
  // rather than every plugin re-deriving it by parsing the mcp__<server>__
  // <tool> name prefix (lossy — server/tool names containing "__" don't
  // round-trip through that split reliably).
  let enrichedInput: HookInput = hookInput
  const toolName = (hookInput as { tool_name?: string }).tool_name
  if (tools && toolName) {
    const tool = findToolByName(tools, toolName)
    if (tool?.mcpInfo) {
      enrichedInput = {
        ...hookInput,
        mcpServer: tool.mcpInfo.serverName,
        mcpTool: tool.mcpInfo.toolName,
        isMcp: true,
      } as HookInput
    }
  }

  try {
    // Identity ⊥. Bridged events are observational: every built-in hook on
    // session.end, tool.result, etc. is an "after" hook that awaits next(e)
    // and then does its real work. Without a default handler the chain
    // bottoms out in a throw, that throw unwinds through every awaiting
    // hook, and none of their after-phases run — sleep/dream consolidation
    // silently produced nothing. Returning the input makes a pass-through
    // chain a normal completion.
    const identity: HookFn = (_$, e, _next) => e

    const result = await dispatch(
      $,
      dotEvent,
      enrichedInput,
      identity,
    )

    if (result == null) return

    // Nothing in the chain rewrote the event — pure observers, no-op.
    if (result === enrichedInput) return

    if (isDenyResult(result)) {
      yield {
        blockingError: {
          blockingError: result.deny,
          command: `algebraic:${dotEvent}`,
        },
      }
      return
    }

    if (typeof result === 'object') {
      const r = result as Record<string, unknown>

      if (r.additionalContext && typeof r.additionalContext === 'string') {
        yield { additionalContexts: [r.additionalContext] }
      }

      if (r.permissionDecision) {
        const decision = r.permissionDecision as string
        if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
          yield {
            permissionBehavior: decision,
            hookPermissionDecisionReason: r.permissionDecisionReason as string | undefined,
          }
        }
      }

      if (r.updatedInput && typeof r.updatedInput === 'object') {
        yield { updatedInput: r.updatedInput as Record<string, unknown> }
      }

      if (r.preventContinuation === true) {
        yield {
          preventContinuation: true,
          stopReason: r.stopReason as string | undefined,
        }
      }
    }
  } catch (error) {
    // ⊥ is reachable only if every hook was skipped by a matcher or the
    // recursion guard — expected, nothing ran, nothing to report. Any
    // other error is a plugin genuinely failing; swallowing those made
    // broken hooks invisible.
    if (!(error instanceof HookChainBottomError)) {
      logError(error)
    }
  }
}
