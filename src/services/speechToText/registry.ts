/**
 * The provider registry: the one place providers advertise themselves and the
 * consuming plugin discovers them.
 *
 * Registration is keyed by provider id and is idempotent: registering an id again
 * replaces the earlier entry, and each call returns its own unregister function that
 * only removes the entry while it is still the one that call installed. Selection is
 * separate from listing, so a caller can point the plugin at a provider by id. Nothing
 * here touches the network or the disk, so importing this module has no side effects.
 */
import type { SpeechProvider } from './types.js'

const providers = new Map<string, SpeechProvider>()
/** The id chosen by the last {@link select} call, or null. */
let selectedId: string | null = null

/**
 * Advertise a provider under its id.
 * @param provider - the recogniser to register.
 * @returns a function that unregisters this exact registration.
 */
export function register(provider: SpeechProvider): () => void {
  providers.set(provider.info.id, provider)
  let released = false
  return () => {
    if (released) return
    released = true
    // Only remove it if nobody re-registered this id afterwards.
    if (providers.get(provider.info.id) === provider) providers.delete(provider.info.id)
  }
}

/** Every registered provider, in insertion order. */
export function list(): SpeechProvider[] {
  return Array.from(providers.values())
}

/** The provider registered under an id, if any. */
export function get(id: string): SpeechProvider | undefined {
  return providers.get(id)
}

/**
 * Choose the provider the plugin should use.
 * @param id - the id to select. It need not be registered yet.
 */
export function select(id: string): void {
  selectedId = id
}

/** The selected provider, or undefined when one was never selected or is missing. */
export function selected(): SpeechProvider | undefined {
  return selectedId === null ? undefined : providers.get(selectedId)
}

/** Forget every registration and the selection. For tests and session teardown. */
export function reset(): void {
  providers.clear()
  selectedId = null
}
