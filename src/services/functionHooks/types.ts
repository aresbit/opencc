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
  | 'tool.invoke'
  | 'tool.result'
  | 'tool.content'
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
  | 'ui.slot.render'
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
  | 'mcp.resource.list'
  | 'mcp.prompt.get'
  | 'mprotect.set'
  | 'mprotect.check'
  | 'mprotect.violation'
  | 'actor.self'
  | 'actor.peers'
  | 'actor.tx'
  | 'actor.rx'
  | 'actor.resource_offer'
  | 'actor.resource_list'
  | 'actor.resource_acquire'
  | 'actor.resource_release'
  | 'ipc.send'
  | 'ipc.recv'
  | 'ipc.subscribe'
  | 'flock.acquire'
  | 'flock.release'
  | 'sudo.check'
  | 'sudo.grant'
  | 'sudo.deny'
  | 'ptrace.attach'
  | 'ptrace.detach'
  | 'ptrace.breakpoint'
  | 'ptrace.step'
  | 'scheduler.route'
  | 'budget.check'
  | 'budget.exceed'
  | 'rsi.antibody.compile'
  | 'rsi.antibody.match'
  | 'rsi.antibody.block'
  | 'rsi.crystal.candidate'
  | 'rsi.crystal.crystallize'
  | 'rsi.experiment.assign'
  | 'rsi.experiment.conclude'
  | 'rsi.critic.judge'
  | 'rsi.critic.distill'
  | 'rsi.sleep.start'
  | 'rsi.sleep.complete'
  | 'rsi.curriculum.classify'
  | 'rsi.curriculum.exercise'
  | 'rsi.constitution.validate'
  | 'rsi.constitution.violation'
  | 'rsi.ratchet.run'
  | 'rsi.ratchet.fail'
  | 'rsi.genome.mutate'
  | 'rsi.genome.export'
  | 'rsi.genome.merge'
  | 'think.eval'
  | 'think.apply'
  | 'think.reflect'
  | 'dream.trigger'
  | 'dream.complete'
  | 'dream.configure'
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

// ── Operations (R7: dispatch by operation, not by event name) ─────
//
// An operation is the typed effect a computation *performs* — "the tool was
// interrupted", "the test failed", "permission was denied" — as distinct from
// the event a hook *observes*. Event-keyed dispatch says "when tool.invoke
// runs, run this hook"; operation-keyed dispatch says "whenever an Interrupted
// effect is performed anywhere, run this handler". That difference is what
// lets handlers compose by operation (several effects, several handlers, one
// computation) instead of a hook having to guess which event a failure will
// surface under.
//
// The listed members are the vocabulary this stage performs. The `string & {}`
// arm keeps the set open so a plugin can perform its own operation without a
// core change, while the literals still autocomplete.
export type FunctionHookOperation =
  | 'Interrupted'
  | 'TimedOut'
  | 'Denied'
  | 'TestFailed'
  | 'Failed'
  | (string & {})

// ── Continuation (R7: next, held and resumed) ────────────────────
//
// A one-shot delimited continuation over "the rest of the chain from this
// point". It is a first-class value: a hook may store it and invoke it after
// it returns, which the inline `next(e)` call cannot do. The one-shot rule is
// OCaml-5's (see docs/control-structure-ladder.md §五): resuming a continuation
// a second time could duplicate side effects the first resume already ran, so
// reuse throws `ContinuationConsumedError` instead of silently re-running.
export interface Continuation<E = unknown, R = unknown> {
  /** Invoke the continuation once with `e`. A second call throws. */
  (e: E): Promise<R>
  /** Alias for invoking, named for the resume path. One-shot, like the call. */
  resume(e: E): Promise<R>
  /** True once this continuation has been invoked. */
  readonly consumed: boolean
  /** The event name this continuation resumes. */
  readonly event: FunctionHookEvent | string
  /** The plugin whose hook captured it, or 'engine'. */
  readonly origin: string
  /** Set when the dispatch this continuation belongs to is operation-addressed. */
  readonly operation?: FunctionHookOperation
}

/**
 * Thrown when a one-shot continuation is invoked after it already ran.
 *
 * Deliberately its own type, not a generic Error: a caller that wants to retry
 * on transient tool failures (retryHook) must NOT catch this and treat it as a
 * retryable tool error — it is a programming error in the handler, and running
 * the computation again is exactly the side-effect duplication the one-shot
 * rule exists to prevent.
 */
export class ContinuationConsumedError extends Error {
  readonly event: FunctionHookEvent | string
  readonly origin: string
  readonly operation?: FunctionHookOperation
  constructor(info: {
    event: FunctionHookEvent | string
    origin: string
    operation?: FunctionHookOperation
  }) {
    super(
      `One-shot continuation already consumed: it was resumed for "${info.event}"` +
        (info.operation ? ` (operation ${info.operation})` : '') +
        ` and cannot be invoked again. Capture a fresh continuation with ` +
        `next.capture() if the computation must be re-entered.`,
    )
    this.name = 'ContinuationConsumedError'
    this.event = info.event
    this.origin = info.origin
    this.operation = info.operation
  }
}

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
  /**
   * The operation this dispatch handles, when it was raised by
   * `dispatchOperation()` rather than by an event name.
   */
  operation?: FunctionHookOperation
  /**
   * Capture the rest of the chain as a first-class one-shot continuation.
   *
   * `next(e)` is the inline forward call: a hook that must re-run the rest of
   * the chain (retry, cache-fill) calls it repeatedly, and the walk is
   * re-derived from this position each time. That is deliberately NOT one-shot
   * — retryHook depends on it. `capture()` is the R7 primitive: it freezes
   * this position into a value the hook can hold, invoke, and resume exactly
   * once, with reuse throwing `ContinuationConsumedError`.
   */
  capture?: () => Continuation<E, R>
  /**
   * Resume this dispatch from its interruption point with `e`. One-shot: the
   * captured continuation is consumed by the first resume, so a second throws.
   */
  resume?: (e: E) => Promise<R>
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
  /**
   * The operation this hook handles, when registered with `on.operation()`.
   *
   * A hook registered for an operation also records the operation name as its
   * `event`, so string-keyed lookups and `listPluginEvents()` keep seeing it;
   * the `operation` field is what marks it as operation-addressed so
   * `getForOperation()` resolves it even if the event name was never used.
   */
  operation?: FunctionHookOperation
  matcher?: HookMatcher
  fn: HookFn
  pluginName: string
  pluginId: string
  order: number
}

// ── Module export shape ──────────────────────────────────────────

export type OnOperationRegistrar = {
  (operation: FunctionHookOperation, fn: HookFn): void
  (operation: FunctionHookOperation, matcher: HookMatcher, fn: HookFn): void
}

export type OnRegistrar = {
  (event: FunctionHookEvent | string, fn: HookFn): void
  (event: FunctionHookEvent | string, matcher: HookMatcher, fn: HookFn): void
  /**
   * Register a handler by the OPERATION it handles rather than the event it
   * runs under. `on.operation('TestFailed', fn)` fires whenever any computation
   * performs `TestFailed`, whatever event that happens inside — which is the
   * whole point of operation dispatch (see FunctionHookOperation above).
   */
  operation: OnOperationRegistrar
}

/**
 * `ctx` is the third argument mods receive (see mods/uiKit.ts). Built-ins are
 * compiled in and import what they need directly, so they ignore it; a mod
 * cannot, which is why it is passed rather than imported.
 */
export type RegisterFn = (
  on: OnRegistrar,
  options?: Record<string, unknown>,
  ctx?: unknown,
) => void

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

/**
 * A hook that intercepts a computation can re-enter it with corrected
 * arguments instead of only denying it. `resume` carries the amended tool
 * input; the interception point (`tool.invoke`) runs the tool again with it,
 * which is the "restart from the interruption point" arm the deny path lacks.
 *
 * A separate member of the same discrimination as `DenyResult` (`resume` vs
 * `deny`) rather than a field on it: a denial ends the call, a resume
 * continues it. A consumer that conflated the two would either drop the
 * amended input or run a computation it was told to refuse.
 */
export interface ResumeResult {
  resume: Record<string, unknown>
}

export function isResumeResult(v: unknown): v is ResumeResult {
  return (
    v != null &&
    typeof v === 'object' &&
    'resume' in v &&
    typeof (v as Record<string, unknown>).resume === 'object' &&
    (v as Record<string, unknown>).resume !== null
  )
}
