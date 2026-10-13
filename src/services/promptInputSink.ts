/**
 * promptInputSink — a module-level bridge for the prompt insert/read surface.
 *
 * Why this exists: the editable prompt buffer is owned by React. `PromptInput`
 * publishes an `insert()` onto `insertTextRef.current` every render
 * (src/components/PromptInput/PromptInput.tsx:269-288). A built-in function-hook
 * plugin runs outside that tree and imports nothing React-shaped, so it cannot
 * hold the ref — and it must not, because `insertTextRef.current` is
 * re-assigned on every render.
 *
 * So REPL publishes *resolvers* once (registerPromptInserter /
 * registerPromptReader), and callers resolve the live surface at call time.
 * Registering a resolver rather than the value itself is the whole point: a
 * captured `insert` would go stale on the next render.
 *
 * Not gated on `VOICE_MODE`. The feature-flagged voice path is a different,
 * cloud-bound route. /voice's push-to-talk now splices through the prompt ref
 * directly, so the resolve-and-splice helpers the old dictation hook used here
 * are gone; only the publishers remain.
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
 * Publish a reader for the current prompt text. Retained as the reader half of
 * the bridge; the dictation hook that used to ask "is the box empty?" now rides
 * /voice's push-to-talk path instead.
 */
export function registerPromptReader(resolver: () => string): () => void {
  resolveReader = resolver
  return () => {
    if (resolveReader === resolver) resolveReader = null
  }
}

/**
 * The current prompt text, or '' when no prompt is mounted. Used by the voice
 * handler to answer "does the box already hold non-ASCII text?" — the proxy for
 * "a CJK IME is composing, so Space is the IME's, not push-to-talk".
 */
export function readPromptText(): string {
  return resolveReader?.() ?? ''
}

/** Test seam: drop the current registration. */
export function resetPromptInserterForTests(): void {
  resolveInserter = null
  resolveReader = null
}
