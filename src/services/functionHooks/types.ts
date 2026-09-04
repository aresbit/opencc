/**
 * Function Hooks: Core Types
 *
 * An effect-parameterized endomorphic continuation model for plugins.
 * Every hook has the signature ($, e, next) => R | Promise<R>.
 */

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'

// ── Event name conventions ───────────────────────────────────────
// Function hooks use dot-notation (tool.call, prompt.submit, ui.render)
// alongside the existing PascalCase names (PreToolUse, PostToolUse).

export type FunctionHookEvent =
  | 'tool.call'
  | 'tool.result'
  | 'tool.error'
  | 'prompt.submit'
  | 'session.start'
  | 'session.end'
  | 'session.compact.pre'
  | 'session.compact.post'
  | 'subagent.start'
  | 'subagent.stop'
  | 'permission.request'
  | 'permission.denied'
  | 'ui.render'
  | 'ui.press'
  | 'ui.log'
  | 'config.change'
  | 'worktree.create'
  | 'worktree.remove'
  | 'cwd.changed'
  | 'file.changed'
  | 'task.created'
  | 'task.completed'
  | 'ctx.fork'
  | 'ctx.branch.start'
  | 'ctx.branch.complete'
  | 'ctx.resolve'
  | 'select.wait'
  | 'select.ready'
  | 'mount.add'
  | 'mount.remove'
  | 'ns.create'
  | 'ns.destroy'
  | 'engine.create'
  | 'plugin.register'
  | '*'

/** Maps dot-notation events to existing HookEvent names where applicable. */
export const EVENT_ALIASES: Partial<Record<FunctionHookEvent, HookEvent>> = {
  'tool.call': 'PreToolUse',
  'tool.result': 'PostToolUse',
  'tool.error': 'PostToolUseFailure',
  'prompt.submit': 'UserPromptSubmit',
  'session.start': 'SessionStart',
  'session.end': 'SessionEnd',
  'session.compact.pre': 'PreCompact',
  'session.compact.post': 'PostCompact',
  'subagent.start': 'SubagentStart',
  'subagent.stop': 'SubagentStop',
  'permission.request': 'PermissionRequest',
  'permission.denied': 'PermissionDenied',
  'config.change': 'ConfigChange',
  'worktree.create': 'WorktreeCreate',
  'worktree.remove': 'WorktreeRemove',
  'cwd.changed': 'CwdChanged',
  'file.changed': 'FileChanged',
  'task.created': 'TaskCreated',
  'task.completed': 'TaskCompleted',
}

/** Reverse map: PascalCase → dot-notation. */
export const REVERSE_ALIASES: Partial<Record<string, FunctionHookEvent>> =
  Object.fromEntries(
    Object.entries(EVENT_ALIASES).map(([k, v]) => [v, k as FunctionHookEvent]),
  )

// ── Next function ────────────────────────────────────────────────

export interface NextFunction<E = unknown, R = unknown> {
  /** Run the rest of the chain with (possibly rewritten) event. */
  (e: E): Promise<R>
  /** Fires when the dispatch completes or is aborted. */
  signal: AbortSignal
  /** Type predicate: narrows e under a * hook. */
  is: (type: FunctionHookEvent, e: unknown) => boolean
  /** The event name of this dispatch. */
  event: FunctionHookEvent | string
  /** The plugin whose hook raised this dispatch, or 'engine'. */
  origin: string
}

// ── Engine Interface ($) ─────────────────────────────────────────

export interface EngineNoun {
  [method: string]: (input: any) => any
}

export interface EngineInterface {
  [noun: string]: EngineNoun
}

// ── Hook callback ────────────────────────────────────────────────

export type HookFn<E = unknown, R = unknown> = (
  $: EngineInterface,
  e: E,
  next: NextFunction<E, R>,
) => R | Promise<R>

// ── Matcher ──────────────────────────────────────────────────────

/** Substructural matcher: a partial of e matched recursively. */
export type HookMatcher = Record<string, unknown> | undefined

// ── Registration record ──────────────────────────────────────────

export interface HookRegistration {
  event: FunctionHookEvent | string
  matcher?: HookMatcher
  fn: HookFn
  pluginName: string
  pluginId: string
  order: number
}

// ── Module export shape ──────────────────────────────────────────

export type OnRegistrar = {
  (event: FunctionHookEvent | string, fn: HookFn): void
  (event: FunctionHookEvent | string, matcher: HookMatcher, fn: HookFn): void
}

export type RegisterFn = (on: OnRegistrar, options?: Record<string, unknown>) => void

export interface HooksModule {
  register: RegisterFn
}

// ── Dispatch result ──────────────────────────────────────────────

export interface DenyResult {
  deny: string
}

export function isDenyResult(v: unknown): v is DenyResult {
  return v != null && typeof v === 'object' && 'deny' in v
}
