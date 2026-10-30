/**
 * Mods: what a user-authored hook module declares about itself.
 *
 * The hook engine already accepted a foreign module — `loadHooksModule` has
 * always been able to import a file and call its `register`. Nothing ever
 * called it. There was no way to say where such a file lives, whether it is
 * on, what it is allowed to touch, or where in the chain it sits, so the
 * capability existed and could not be reached.
 *
 * A manifest is what turns "a file that exports register()" into something a
 * person can install, read, switch off and trust.
 */

/** Where a mod sits relative to the built-in chain. */
export type ModPosition =
  /**
   * Append: innermost, below every built-in. The mod sees an event only if
   * every guard above it allowed it through — the right place for a default.
   */
  | 'inner'
  /**
   * Prepend: outermost, wrapping the built-ins. The mod sees the event first
   * and can refuse it before anything else spends work — the control
   * position, and the reason it is spelled out rather than implied by load
   * order.
   */
  | 'outer'

/**
 * A named action a mod offers.
 *
 * Hooks are how a mod reacts; a command is how it is *asked*. The difference
 * is the difference between an event and a verb: `tool.call` fires because
 * something else happened, `hello` runs because a person pressed a key, typed
 * `opencc mods run hello hello`, or another mod called it. Without this a mod
 * could only grab raw keys through `ui.press` — invisible, unnamed, and
 * impossible to invoke from anywhere but the terminal that was focused.
 *
 * The declaration is metadata only. The work still goes through the hook
 * chain: `on('command.invoke', { command: name }, fn)`. That is deliberate —
 * it means a command inherits capability scoping, quarantine and chain
 * position without the loader growing a second dispatch mechanism.
 */
export interface ModCommand {
  /** Stable name, unique within the mod: `[a-z0-9][a-z0-9._-]*`. */
  name: string
  /** Shown in listings; defaults to `name`. */
  title?: string
  /**
   * `ctrl+shift+r` (same syntax as the keybinding layer). Optional: a command
   * without a key is still reachable by name from the CLI and from other
   * mods. One key is one command — a chord is not supported here.
   */
  key?: string
  /** One line for `opencc mods describe`. */
  doc?: string
}

export interface ModManifest {
  /** Directory name by default; must be unique across both mod directories. */
  name: string
  /** One line, shown in listings. */
  description?: string
  /**
   * The long form: what this mod is for, in a person's words. `description`
   * is a label, this is the manual — `opencc mods describe` prints it, and a
   * host shows it beside the mod. It is not sent to the model.
   */
  doc?: string
  /** Runnable snippets for `opencc mods describe`; not executed by anyone. */
  examples?: string[]
  version?: string
  /**
   * Off switches the mod out of the chain without editing its code, which is
   * the point: an admin disabling a mod should not have to modify it.
   */
  enabled?: boolean
  position?: ModPosition
  /**
   * Chain placement relative to other mods and to built-in hook plugins.
   *
   * `before` names anything this mod must be outside of (registered earlier);
   * `after` names anything it must sit inside (registered later). Both accept
   * a mod name or a built-in plugin name ("compress", "cache", …). A target
   * that is neither is refused rather than silently ignored — a typo in an
   * ordering declaration would otherwise leave the mod in a position nobody
   * chose, which is the one thing this field exists to prevent.
   *
   * Placement is computed over the whole set of discovered mods, not from the
   * order the filesystem happened to return. `position: 'outer'` is a coarse
   * form of `before` (before every built-in) and still lifts the mod to the
   * front; among several outer mods, the topological order decides.
   */
  order?: ModOrder
  /**
   * Dependencies this mod declares. `hook:<name>` is a chain placement — the
   * same as `order: { after: [name] }` — and anything else names a service
   * another mod `provides`. A service with no loaded provider leaves this mod
   * `pending`: not in the chain, but waiting rather than broken.
   */
  inject?: string[]
  /**
   * Service names this mod supplies during `register()` via `ctx.provide`.
   * Every name declared here must actually be provided; a mod that declares
   * one and forgets it fails loudly rather than leaving its consumers waiting
   * forever on a service that will never arrive.
   */
  provides?: string[]
  /**
   * Which `$` nouns this mod may touch. Undeclared access throws rather than
   * returning undefined, and the error names the noun to add here.
   *
   * `['*']` grants everything. It is written out rather than being the
   * default so that a mod's reach is readable from its manifest instead of
   * from its source.
   */
  capabilities?: string[]
  /** Commands this mod offers; see `ModCommand`. */
  commands?: ModCommand[]
  /** Passed to `register(on, options)`. */
  options?: Record<string, unknown>
}

/** Relative chain placement; see `ModManifest.order`. */
export interface ModOrder {
  before?: string[]
  after?: string[]
}

/**
 * Which search root a mod came from, in increasing precedence. `bundled` is
 * what the host ships (OPENCC_BUNDLED_MODS); the person's own and the
 * project's mods shadow it by name.
 */
export type ModScope = 'bundled' | 'user' | 'project'

export interface ModSource {
  /** Resolved manifest, after mod.json has overridden anything inline. */
  manifest: ModManifest
  /** The file that exports `register`. */
  entry: string
  /** Directory the mod came from, for reporting. */
  dir: string
  /** Which search root found it — a project mod shadows a user mod by name. */
  scope: ModScope
}

export interface LoadedMod extends ModSource {
  pluginId: string
  /** Events this mod's hooks sit on, read back from the registry. */
  events: string[]
  /** Commands that survived validation, with their keys as actually bound. */
  commands: ModCommand[]
}

export interface ModLoadResult {
  name: string
  entry: string
  /** Directory the mod came from (the mods root itself for a one-file mod). */
  dir: string
  scope: ModScope
  /**
   * The manifest as the chain sees it: the mod's inline \`manifest\` with
   * mod.json applied over it. Only mod.json is known when the import fails.
   */
  manifest?: ModManifest
  loaded: boolean
  events: string[]
  /**
   * Why this mod is not in the chain. A disabled mod, a broken one and one
   * waiting on a service are all "not loaded" and are not the same thing, so
   * the reason is carried rather than inferred from the absence.
   */
  skipped?: 'disabled' | 'shadowed' | 'pending'
  error?: string
  /**
   * For `skipped: 'pending'`: the injected services no loaded provider could
   * supply. Named so a host can say "waiting on `research-index`" instead of
   * a bare "not loaded".
   */
  pendingOn?: string[]
  /**
   * Set when a *reload* failed while its previous version was still in the
   * chain. The previous registrations are restored, so the mod keeps working;
   * this says the new code did not take effect.
   */
  reloadFailed?: string
  /**
   * Non-fatal problems: a command whose key was taken, an unknown capability
   * name, a malformed entry that was skipped. The mod loaded; these are the
   * parts of its declaration that did not. Kept apart from `error` so "this
   * half did not work" is never printed as "this mod did not load".
   */
  warnings?: string[]
}
