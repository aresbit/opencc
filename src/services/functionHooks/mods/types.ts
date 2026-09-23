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

export interface ModManifest {
  /** Directory name by default; must be unique across both mod directories. */
  name: string
  /** One line, shown in listings. */
  description?: string
  version?: string
  /**
   * Off switches the mod out of the chain without editing its code, which is
   * the point: an admin disabling a mod should not have to modify it.
   */
  enabled?: boolean
  position?: ModPosition
  /**
   * Which `$` nouns this mod may touch. Undeclared access throws rather than
   * returning undefined, and the error names the noun to add here.
   *
   * `['*']` grants everything. It is written out rather than being the
   * default so that a mod's reach is readable from its manifest instead of
   * from its source.
   */
  capabilities?: string[]
  /** Passed to `register(on, options)`. */
  options?: Record<string, unknown>
}

export interface ModSource {
  /** Resolved manifest, after mod.json has overridden anything inline. */
  manifest: ModManifest
  /** The file that exports `register`. */
  entry: string
  /** Directory the mod came from, for reporting. */
  dir: string
  /** Which search root found it — a project mod shadows a user mod by name. */
  scope: 'user' | 'project'
}

export interface LoadedMod extends ModSource {
  pluginId: string
  /** Events this mod's hooks sit on, read back from the registry. */
  events: string[]
}

export interface ModLoadResult {
  name: string
  entry: string
  scope: 'user' | 'project'
  loaded: boolean
  events: string[]
  /**
   * Why this mod is not in the chain. A disabled mod and a broken one are
   * both "not loaded" and are not the same thing, so the reason is carried
   * rather than inferred from the absence.
   */
  skipped?: 'disabled' | 'shadowed'
  error?: string
}
