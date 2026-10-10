/**
 * Default provider registration — the consumer the substrate's contract asks for.
 *
 * registry.ts is deliberately inert on import: nothing is registered and nothing
 * is fetched until a consumer decides. This module is that consumer for the
 * built-in engines, so a plugin's `list()[0]` finds a recogniser instead of an
 * empty list. Without it the dictation path had no provider to select and every
 * press reported "no speech engine available" — the seam existed but nothing was
 * plugged into it.
 *
 * Construction and registration are pure and offline: building a provider reads
 * no files and opens no socket. Only `provision()` touches the network, and only
 * when a caller invokes it (the plugin does so on first use of a downloadable
 * engine). So calling this at startup costs nothing on a machine with no engine.
 */
import { register, reset as resetRegistry, select } from './registry.js'
import { createWhistleProvider } from './providers/whistleCactus.js'
import { createWhisperCppProvider } from './providers/whisperCpp.js'

let registered = false

/**
 * Register the built-in providers, once.
 *
 * Order matters: Whistle is first because it is the only engine that is fully
 * self-provisioning (its engine binary and model are both fetched on demand),
 * so it is the entry a bare machine can actually reach. whisper.cpp follows as a
 * fallback — it needs a `whisper-cli` already on PATH, which a developer box may
 * have and a fresh one will not.
 *
 * Whistle is selected explicitly rather than left to insertion order: selection
 * is what the plugin consults first, and naming it here states the intent instead
 * of relying on the registry's Map ordering.
 */
export function registerDefaultProviders(): void {
  if (registered) return
  registered = true
  register(createWhistleProvider())
  register(createWhisperCppProvider())
  select('whistle')
}

/**
 * Undo {@link registerDefaultProviders}: forget the registrations, the selection,
 * and the once-only guard, so a later init (hot reload, tests) can register again.
 * Both halves must move together — clearing the registry while the guard stayed
 * set would leave the next init believing providers were already present.
 */
export function resetDefaultProvidersForTests(): void {
  registered = false
  resetRegistry()
}
