/**
 * Choosing which registered engine a consumer should use, and getting it ready.
 *
 * The registry lists candidates; this decides among them. Two consumers need the
 * same decision — the dictation hook and the push-to-talk voice session — so it
 * lives here rather than privately in either. The rule is availability, not
 * selection order: the selected provider is tried first, the rest follow, and the
 * first one that can actually run wins. When none can run but one advertises a
 * download, it is provisioned on the spot — a consumer reaching here has already
 * decided to use speech, which is the "chosen" moment the substrate waits for.
 */
import { list, selected } from './registry.js'
import type { ProviderAvailability, SpeechProvider } from './types.js'

/** A chosen engine and the availability that justified choosing it. */
export interface ActiveProvider {
  provider: SpeechProvider
  availability: ProviderAvailability
}

/** Options for {@link resolveActiveProvider}. */
export interface ResolveOptions {
  /** Cancels a provisioning download, and is passed to nothing else. */
  signal?: AbortSignal
  /** Progress line while an engine is being fetched (e.g. "downloading …"). */
  onStatus?: (message: string | null) => void
}

/**
 * Pick the engine to use, provisioning a downloadable one if that is what it takes.
 *
 * @returns the chosen provider and its (re-checked) availability, or null when no
 *          provider is registered at all.
 */
export async function resolveActiveProvider(
  opts: ResolveOptions = {},
): Promise<ActiveProvider | null> {
  const preferred = selected()
  const all = list()
  const ordered = preferred ? [preferred, ...all.filter(p => p !== preferred)] : all
  if (ordered.length === 0) return null

  // Availability is a cheap, offline probe (a stat / a PATH scan), so trying
  // each provider is fine; the first usable one is the answer.
  let first: ActiveProvider | null = null
  for (const provider of ordered) {
    const availability = await provider.availability()
    if (availability.available) return { provider, availability }
    first ??= { provider, availability }
  }

  const candidate = first!
  const provision = candidate.provider.provision
  if (candidate.provider.info.downloadable && provision) {
    opts.onStatus?.(`downloading ${candidate.provider.info.name}…`)
    await provision({ signal: opts.signal })
    opts.signal?.throwIfAborted()
    return { provider: candidate.provider, availability: await candidate.provider.availability() }
  }
  return candidate
}

/**
 * Whether any engine is registered, synchronously.
 *
 * Providers are registered once at startup (speechToText/bootstrap.ts), so this
 * is a cheap, dependency-free way for a render path to ask "is local speech even
 * possible here?" without touching the disk or the network. A true answer does
 * not promise an engine is *provisioned* — that is what resolveActiveProvider
 * settles, asynchronously, at first use.
 */
export function hasLocalSttProvider(): boolean {
  return list().length > 0
}
