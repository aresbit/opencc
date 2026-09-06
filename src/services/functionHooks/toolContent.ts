/**
 * tool.content — the transform point where a hook's resume value actually
 * becomes what the model sees.
 *
 * Why this exists (and why `tool.result` was not enough):
 *
 * `tool.result` is bridged from PostToolUse. Tracing what PostToolUse can
 * actually do to a tool result:
 *
 *   - bridge.ts only yields on OBJECT results carrying specific keys
 *     (deny / additionalContext / permissionDecision / updatedInput /
 *     preventContinuation). A hook returning a plain string falls through
 *     `typeof result === 'object'` and is dropped.
 *   - AggregatedHookResult has no field for replacing a tool result's
 *     content at all — `updatedMCPToolOutput` exists, but only for MCP
 *     tools.
 *   - and for non-MCP tools it is moot anyway: toolExecution.ts calls
 *     `addToolResult(toolOutput, mappedToolResultBlock)` BEFORE
 *     `runPostToolUseHooks(...)`, so the message the model will see is
 *     already built by the time a PostToolUse hook runs.
 *
 * So a `tool.result` hook is observational-only — exactly the "退化 handler"
 * (block/observe, cannot resume with a transformed value) that hook systems
 * are usually stuck with. contextHandleHook.ts was written as though it
 * could rewrite the result, and its handle-ization was silently discarded:
 * it stored full content in a Map and returned a preview string into the
 * void.
 *
 * `tool.content` closes that gap. It is dispatched from inside
 * `addToolResult`, on the assembled ToolResultBlockParam, before the
 * message is pushed — the one chokepoint every tool's output passes
 * through, MCP and non-MCP alike. A hook chain on this event receives the
 * content string and whatever it returns becomes the content the model
 * receives. That is a real `resume(v)`: the continuation only ever sees
 * the value the handler chose to give it.
 *
 * Deliberate limits:
 * - String content only. A block whose content is an array (images, mixed
 *   blocks) is passed through untouched — narrowing those would need
 *   per-block semantics no current plugin has.
 * - Fail-open. Any throw, a missing engine, or a non-string return leaves
 *   the original block exactly as it was. Context narrowing is an
 *   optimization; it must never be able to lose a tool result.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getEngine } from './bridge.js'
import { dispatch, HookChainBottomError } from './dispatcher.js'
import { logError } from '../../utils/log.js'

export interface ToolContentEvent {
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
  agent_id?: string
  /** The text the model would receive if no hook narrowed it. */
  content: string
}

/**
 * Run the `tool.content` chain over an assembled tool result block.
 * Returns the block to actually send — the original object when nothing
 * rewrote it, so callers can compare by reference if they care.
 */
export async function applyToolContentHooks(
  block: ToolResultBlockParam,
  meta: Omit<ToolContentEvent, 'content'>,
): Promise<ToolResultBlockParam> {
  const content = block.content
  if (typeof content !== 'string' || content.length === 0) return block

  const $ = getEngine()
  if (!$) return block

  try {
    const event: ToolContentEvent = { ...meta, content }
    const result = await dispatch($, 'tool.content', event, (_$, e) => e)

    // A chain of pure observers returns the event object unchanged.
    if (result === event || result == null) return block

    // Hooks narrow content by returning the replacement string directly.
    // An object carrying { content } is also accepted so a hook can pass
    // the event through with a rewritten field.
    const rewritten =
      typeof result === 'string'
        ? result
        : typeof result === 'object' &&
            'content' in (result as Record<string, unknown>) &&
            typeof (result as { content: unknown }).content === 'string'
          ? (result as { content: string }).content
          : null

    if (rewritten === null || rewritten === content) return block

    return { ...block, content: rewritten }
  } catch (error) {
    // ⊥ means no hook matched — normal, nothing to narrow.
    if (error instanceof HookChainBottomError) return block
    // A plugin genuinely failed. The tool result matters more than the
    // optimization, so send the original rather than propagating — but LOG
    // it: swallowing silently is how a broken narrowing hook stays invisible
    // while quietly doing nothing, which is the exact failure mode this
    // whole event was added to eliminate. bridge.ts logs non-⊥ errors for
    // the same reason.
    logError(error)
    return block
  }
}
