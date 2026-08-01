/**
 * Latent-state merge primitives for Mythos.
 *
 * None of this logic had ever executed before the empty-prompt fix: every
 * phase returned a confusion reply, so no JSON ever parsed, so nothing was
 * ever merged. The bugs below were found by driving these paths with
 * realistic payloads for the first time.
 *
 * Kept pure and separate from the subagent calls so they can be tested
 * without an LLM in the loop.
 */

type SourceRecord = {
  url_or_citation: string
  source_type: string
  credibility_note?: string
}

type ClaimLike = {
  id: string
  sources: string[]
  source_types: string[]
  confirms: string[]
  extends: string[]
  challenged_by: string[]
  [key: string]: unknown
}

type ContradictionLike = {
  id: string
  claim_ids_involved: string[]
  [key: string]: unknown
}

type StateLike = {
  claims: ClaimLike[]
  contradictions: ContradictionLike[]
  allSources: SourceRecord[]
  sourceTypeCounts: Record<string, number>
}

/** Normalize a citation for identity comparison across iterations. */
function sourceKey(record: SourceRecord): string {
  return record.url_or_citation
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/[?#].*$/, '')
}

/**
 * Recompute the source-type histogram from `allSources`.
 *
 * This used to be an accumulator incremented in two places — once per source
 * record, and again for every `source_types` entry on every claim — and
 * decremented nowhere, including when distillation merged a claim away. The
 * count therefore drifted upward without bound and bore no relation to the
 * sources actually consulted.
 *
 * That matters beyond tidiness. The halting rule reads
 * `Object.keys(sourceTypeCounts).length >= 3` as "diversity budget met", and
 * claim-level `source_types` are self-declared labels, not source records — a
 * claim could be tagged `academic` with no academic source behind it. Counting
 * them added histogram *keys*, so a run backed by one blog post could declare
 * four source types and clear the diversity gate. Verified against the old
 * code path.
 *
 * Deriving the histogram from the one list that holds actual retrieved
 * sources means it cannot drift and cannot be inflated by self-labelling.
 */
export function recomputeSourceTypeCounts(state: StateLike): void {
  const counts: Record<string, number> = {}
  for (const s of state.allSources) {
    const t = s.source_type?.trim()
    if (t) counts[t] = (counts[t] ?? 0) + 1
  }
  state.sourceTypeCounts = counts
}

/**
 * Add sources, skipping ones already recorded.
 *
 * A source consulted at depth 1 and cited again at depth 3 is one source. The
 * previous code pushed unconditionally, so re-reading the canonical paper on a
 * topic — exactly what a deep dive does — inflated both the source count and
 * the diversity map.
 *
 * Returns the number genuinely new, so the caller can report progress
 * honestly rather than reporting re-reads as discoveries.
 */
export function addSources(
  state: StateLike,
  incoming: readonly SourceRecord[],
): number {
  const seen = new Set(state.allSources.map(sourceKey))
  let added = 0
  for (const s of incoming) {
    const key = sourceKey(s)
    if (!key || seen.has(key)) continue
    seen.add(key)
    state.allSources.push(s)
    added++
  }
  if (added > 0) recomputeSourceTypeCounts(state)
  return added
}

/**
 * Add claims, renaming on ID collision instead of dropping.
 *
 * The recurrent prompt asks for ids shaped `c<depth>_<direction-short>_<n>`,
 * which collide readily across parallel directions at the same depth — two
 * directions whose titles share a prefix produce the same short form. The old
 * merge skipped any claim whose id already existed, so a genuine finding was
 * silently discarded because an unrelated claim happened to share a label.
 *
 * Renaming preserves the finding. True duplicates are distillation's job, and
 * it has the evidence to judge them; this layer must not decide by name
 * collision alone.
 *
 * Returns the claims actually appended (with any rewritten ids).
 */
export function addClaims<T extends ClaimLike>(
  state: StateLike,
  incoming: readonly T[],
): T[] {
  const existing = new Set(state.claims.map(c => c.id))
  const added: T[] = []
  for (const claim of incoming) {
    let id = claim.id
    if (existing.has(id)) {
      let suffix = 2
      while (existing.has(`${claim.id}__${suffix}`)) suffix++
      id = `${claim.id}__${suffix}`
    }
    existing.add(id)
    const stored = id === claim.id ? claim : { ...claim, id }
    state.claims.push(stored)
    added.push(stored)
  }
  return added
}

/**
 * Drop a claim that distillation merged into another, rewriting every
 * reference to it.
 *
 * Callers must run this rather than filtering `state.claims` directly, so the
 * source histogram is rebuilt afterwards — merging a claim used to leave its
 * source-type contributions permanently in the counts.
 */
export function mergeClaimInto(
  state: StateLike,
  keptId: string,
  mergedId: string,
): boolean {
  if (keptId === mergedId) return false
  const kept = state.claims.find(c => c.id === keptId)
  const merged = state.claims.find(c => c.id === mergedId)
  if (!kept || !merged) return false

  for (const s of merged.sources) if (!kept.sources.includes(s)) kept.sources.push(s)
  for (const t of merged.source_types) {
    if (!kept.source_types.includes(t)) kept.source_types.push(t)
  }
  const mergedEvidence = (merged.evidence as string[] | undefined) ?? []
  const keptEvidence = (kept.evidence as string[] | undefined) ?? []
  for (const e of mergedEvidence) if (!keptEvidence.includes(e)) keptEvidence.push(e)

  state.claims = state.claims.filter(c => c.id !== mergedId)

  for (const c of state.claims) {
    c.confirms = dedupe(c.confirms.map(r => (r === mergedId ? keptId : r)))
    c.extends = dedupe(c.extends.map(r => (r === mergedId ? keptId : r)))
    c.challenged_by = dedupe(c.challenged_by.map(r => (r === mergedId ? keptId : r)))
  }
  for (const x of state.contradictions) {
    x.claim_ids_involved = dedupe(
      x.claim_ids_involved.map(r => (r === mergedId ? keptId : r)),
    )
  }

  // A claim must not cite itself as confirming or extending itself, which is
  // what the rewrite above produces when the merged claim referenced its kept
  // sibling.
  kept.confirms = kept.confirms.filter(r => r !== keptId)
  kept.extends = kept.extends.filter(r => r !== keptId)
  kept.challenged_by = kept.challenged_by.filter(r => r !== keptId)

  recomputeSourceTypeCounts(state)
  return true
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * Claims that reference a claim id which does not exist.
 *
 * Dangling references accumulate when the model invents an id in `confirms`
 * or when a claim fails schema validation and is dropped while a later claim
 * still points at it. Surfacing them keeps the claim graph honest; the Coda
 * renders that graph as if every edge resolves.
 */
export function findDanglingReferences(state: StateLike): Array<{
  claimId: string
  field: 'confirms' | 'extends' | 'challenged_by'
  missing: string
}> {
  const ids = new Set(state.claims.map(c => c.id))
  const out: Array<{
    claimId: string
    field: 'confirms' | 'extends' | 'challenged_by'
    missing: string
  }> = []
  for (const c of state.claims) {
    for (const field of ['confirms', 'extends', 'challenged_by'] as const) {
      for (const ref of c[field]) {
        if (ref && !ids.has(ref)) {
          out.push({ claimId: c.id, field, missing: ref })
        }
      }
    }
  }
  return out
}
