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
import { dispatch } from './dispatcher.js'
import { buildEngineInterface, buildCoreNouns } from './engine.js'
import { registry } from './registry.js'
import { REVERSE_ALIASES, isDenyResult, type EngineInterface, type FunctionHookEvent } from './types.js'

let engineInterface: EngineInterface | null = null
let engineInitPromise: Promise<EngineInterface> | null = null

/**
 * Initialize the engine interface ($). Safe to call multiple times —
 * the first call builds $, subsequent calls return the cached instance.
 */
export async function initEngine(): Promise<EngineInterface> {
  if (engineInterface) return engineInterface
  if (engineInitPromise) return engineInitPromise

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
): AsyncGenerator<AggregatedHookResult> {
  const dotEvent = REVERSE_ALIASES[hookEvent] as FunctionHookEvent | undefined
  if (!dotEvent) return

  const hooks = registry.getForEvent(dotEvent)
  if (hooks.length === 0) return

  const $ = engineInterface
  if (!$) return

  try {
    const result = await dispatch(
      $,
      dotEvent,
      hookInput,
    )

    if (result == null) return

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
  } catch {
    // Algebraic-effect chain reached bottom (⊥) — no handler. This is
    // expected when hooks are registered on the event but all were
    // skipped by matchers or recursion guard. Swallow silently.
  }
}
