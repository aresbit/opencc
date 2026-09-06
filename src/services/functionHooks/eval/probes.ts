/**
 * Probes: the facts a narrowed context still has to be able to produce.
 *
 * A cost-only evaluation has a degenerate optimum — deliver nothing, save
 * everything — so cost numbers alone cannot choose a configuration. A probe
 * is an exact substring that some piece of work needed out of a tool result.
 * After narrowing, each probe lands in one of three states:
 *
 *   direct       still present verbatim in what the model received
 *   recoverable  gone from context, but deref() can still fetch it
 *   lost         neither
 *
 * This matches what the narrowing design actually promises — a summary to
 * orient by, plus exact bytes on demand — so it tests the claim rather than
 * a proxy for it. And it is checkable without a model in the loop, which
 * keeps a comparison deterministic and free.
 *
 * `lost` is the disqualifying outcome. `recoverable` is not a failure but is
 * not free either: it costs a round trip, so it is tracked separately as
 * friction rather than folded into a single score that would hide the
 * difference.
 */

/** Lines too generic to prove anything about information preservation. */
function isDistinctive(line: string): boolean {
  const t = line.trim()
  if (t.length < 24 || t.length > 200) return false
  // Punctuation-only structure (closing braces, separators) appears
  // everywhere and would be "found" in unrelated content by coincidence.
  if (!/[A-Za-z_]{4,}/.test(t)) return false
  // Comment prose is legitimate content, but a bare marker line is not
  // distinctive enough to be evidence.
  if (/^[/*#\-=\s]+$/.test(t)) return false
  return true
}

/**
 * Derive probes from content when a trace has not been hand-labelled.
 *
 * Sampled evenly across the whole result rather than from the head,
 * deliberately: contextHandle's preview keeps the first N lines, so probes
 * drawn from the top would all come back `direct` and report a preserved
 * recall that says nothing about the rest of the file.
 */
export function autoProbes(content: string, count = 5): string[] {
  const candidates = content.split('\n').filter(isDistinctive)
  if (candidates.length === 0) return []

  const n = Math.min(count, candidates.length)
  const probes: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < n; i++) {
    // Spread across the body, skipping the very start for the reason above.
    const idx = Math.floor(((i + 0.5) / n) * candidates.length)
    const line = candidates[Math.min(idx, candidates.length - 1)]!.trim()
    if (!seen.has(line)) {
      seen.add(line)
      probes.push(line)
    }
  }
  return probes
}

/** Attach auto-derived probes to any step that lacks them. */
export function withAutoProbes<T extends { result: string; probes?: string[] }>(
  steps: T[],
  count = 5,
): T[] {
  return steps.map(s =>
    s.probes?.length ? s : { ...s, probes: autoProbes(s.result, count) },
  )
}
