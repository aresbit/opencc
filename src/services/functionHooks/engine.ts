/**
 * The Engine Interface ($).
 *
 * $ is everything a hook can see or do. It's an object of nouns, each an
 * object of events: $.<noun>.<event>(input). Every method is hookable.
 *
 * The engine builds $ once at startup by running the engine.create chain.
 * Its ⊥ returns the empty table; the core plugin (registered last) adds
 * the primitives; every other step adds its own nouns. A name once added
 * belongs to the plugin which added it for the life of the fold.
 *
 * The returned $ is frozen and handed to every hook.
 */

import type { EngineInterface, EngineNoun, FunctionHookEvent, HookFn } from './types.js'
import { dispatch } from './dispatcher.js'

export interface EngineCreateEvent {
  /** Nouns accumulated so far (starts empty). */
  nouns: Record<string, Record<string, (...args: any[]) => any>>
}

/**
 * Make a noun's methods dispatchable: calling $.noun.event(input) runs the
 * hook chain for "noun.event", with the method's own implementation at ⊥.
 */
function wrapNoun(
  $ref: { current: EngineInterface },
  nounName: string,
  methods: Record<string, (...args: any[]) => any>,
): EngineNoun {
  const wrapped: EngineNoun = {}
  for (const [methodName, impl] of Object.entries(methods)) {
    const eventName = `${nounName}.${methodName}` as FunctionHookEvent
    wrapped[methodName] = (input: any) => {
      const defaultHandler: HookFn = (_$, e, _next) => impl(e)
      return dispatch($ref.current, eventName, input, defaultHandler)
    }
  }
  return Object.freeze(wrapped)
}

/**
 * Build $ from the engine.create fold.
 *
 * Plugins contribute nouns via on("engine.create", async ($, e, next) => {
 *   const below = await next(e)
 *   return { ...below, myNoun: createMyNoun(below) }
 * })
 */
export async function buildEngineInterface(
  coreNouns: Record<string, Record<string, (...args: any[]) => any>>,
): Promise<EngineInterface> {
  // $ref is a mutable box so wrapped methods close over the final frozen $.
  const $ref: { current: EngineInterface } = { current: {} }

  const coreHandler: HookFn<EngineCreateEvent, EngineCreateEvent> = (
    _$,
    e,
    _next,
  ) => {
    return { ...e, nouns: { ...e.nouns, ...coreNouns } }
  }

  let result: EngineCreateEvent
  try {
    result = await dispatch<EngineCreateEvent, EngineCreateEvent>(
      {} as EngineInterface, // $ is empty during the fold
      'engine.create',
      { nouns: {} },
      coreHandler as HookFn,
    )
  } catch {
    // No hooks on engine.create — just use core nouns.
    result = { nouns: coreNouns }
  }

  // Wrap every noun's methods so they dispatch through the hook chain.
  const iface: Record<string, EngineNoun> = {}
  for (const [nounName, methods] of Object.entries(result.nouns)) {
    iface[nounName] = wrapNoun($ref, nounName, methods)
  }

  const frozen = Object.freeze(iface) as EngineInterface
  $ref.current = frozen
  return frozen
}

/**
 * Build the core nouns from opencc's existing capabilities.
 * Each noun is an object of methods that do the real work.
 */
export function buildCoreNouns(): Record<
  string,
  Record<string, (...args: any[]) => any>
> {
  return {
    tool: {
      call: async (e: { tool: string; input: unknown }) => {
        // Default: delegate to the existing tool execution path.
        // The integration layer replaces this with the real tool runner.
        return { result: `tool ${e.tool} called (no integration handler)` }
      },
    },
    prompt: {
      submit: async (e: { text: string }) => {
        return { text: e.text }
      },
    },
    ui: {
      log: (e: { message: string; level?: string }) => {
        // Default: stderr log.
        process.stderr.write(`[hook:ui.log] ${e.message}\n`)
      },
      render: async (e: { component: string; props: unknown; surface?: string }) => {
        return { component: e.component, props: e.props }
      },
    },
    fs: {
      read: async (e: { path: string }) => {
        const { readFile } = await import('fs/promises')
        return { content: await readFile(e.path, 'utf-8') }
      },
      write: async (e: { path: string; content: string }) => {
        const { writeFile } = await import('fs/promises')
        await writeFile(e.path, e.content)
        return { written: true }
      },
    },
    session: {
      start: async (e: unknown) => e,
      end: async (e: unknown) => e,
    },
    tui: {
      registerView: async (e: { view: import('../tuiRegistry/types.js').TuiViewDefinition }) => {
        const { registerView } = await import('../tuiRegistry/registry.js')
        registerView(e.view)
        return { registered: e.view.id }
      },
      registerWidget: async (e: { widget: import('../tuiRegistry/types.js').TuiWidget }) => {
        const { registerWidget } = await import('../tuiRegistry/registry.js')
        registerWidget(e.widget)
        return { registered: e.widget.id }
      },
      configure: async (e: { agentId: string; config: import('../tuiRegistry/types.js').AgentTuiConfig }) => {
        const { setAgentTuiConfig } = await import('../tuiRegistry/registry.js')
        setAgentTuiConfig(e.agentId, e.config)
        return { configured: e.agentId }
      },
    },
  }
}
