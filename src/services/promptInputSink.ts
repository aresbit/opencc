/**
 * promptInputSink — a module-level bridge for splicing text into the prompt.
 *
 * Why this exists: the editable prompt buffer is owned by React. `PromptInput`
 * publishes an `insert()` onto `insertTextRef.current` every render
 * (src/components/PromptInput/PromptInput.tsx:269-288), and its own comment
 * names STT as the intended caller. But a built-in function-hook plugin runs
 * outside that tree and imports nothing React-shaped, so it cannot hold the
 * ref — and it must not, because `insertTextRef.current` is re-assigned on
 * every render.
 *
 * So REPL publishes a *resolver* once, and callers resolve the live inserter at
 * call time. Registering a resolver rather than the inserter itself is the
 * whole point: a captured `insert` would go stale on the next render.
 *
 * Not gated on `VOICE_MODE`. The feature-flagged voice path is a different,
 * cloud-bound route; this bridge is what the local STT hook plugin uses.
 */

/** Splices `text` into the prompt at the cursor. */
export type PromptInserter = (text: string) => void

let resolveInserter: (() => PromptInserter | undefined) | null = null
let resolveReader: (() => string) | null = null

/**
 * Publish the live-inserter resolver. Called once by REPL. Returns a disposer
 * that clears the registration only if it is still the current one, so a
 * remount cannot unpublish a newer registration.
 */
export function registerPromptInserter(
  resolver: () => PromptInserter | undefined,
): () => void {
  resolveInserter = resolver
  return () => {
    if (resolveInserter === resolver) resolveInserter = null
  }
}

/**
 * Publish a reader for the current prompt text.
 *
 * The `ui.press` bridge carries no prompt state (UIPressBridge.tsx:30-33),
 * so a keybinding hook cannot otherwise answer "is the box empty?" — which is
 * what lets space-to-talk coexist with typing a space.
 */
export function registerPromptReader(resolver: () => string): () => void {
  resolveReader = resolver
  return () => {
    if (resolveReader === resolver) resolveReader = null
  }
}

/** The current prompt text, or '' when no prompt is mounted. */
export function readPromptText(): string {
  return resolveReader?.() ?? ''
}

/** True when a prompt input is mounted and can accept inserted text. */
export function hasPromptInserter(): boolean {
  return typeof resolveInserter?.() === 'function'
}

/**
 * Splice `text` into the prompt at the cursor. Returns false (and does
 * nothing) when no prompt input is mounted — the caller decides whether that
 * is an error; for a plugin it usually just means "not in the REPL".
 */
export function insertPromptText(text: string): boolean {
  const inserter = resolveInserter?.()
  if (!inserter) return false
  inserter(text)
  return true
}

/** Test seam: drop the current registration. */
export function resetPromptInserterForTests(): void {
  resolveInserter = null
  resolveReader = null
}
