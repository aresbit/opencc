/**
 * Domain-knowledge extraction from real commit diffs.
 *
 * The lecture section titled 「领域知识（Domain Knowledge）」 used to be produced
 * by `inferDomainKnowledge`: a lookup table of nine hardcoded Chinese sentences
 * keyed on substring matches over the repo name, changed *filenames* and the
 * README. `text.includes('quant')` emitted one fixed sentence; a `.py` file
 * emitted another. It never read a diff and never read code, so every Python
 * quant repository produced a byte-identical "domain knowledge" section
 * regardless of what the commits actually did — and when no keyword matched it
 * emitted 「领域语义较弱」, a sentence that says nothing.
 *
 * That is worse than the analogous fakes elsewhere in this codebase, because
 * the lecture *is* the deliverable: it gets published to GitHub Pages for a
 * human to read as knowledge.
 *
 * This module replaces it with an actual reading of the patch, via `sideQuery`
 * with a JSON-schema output format — the same mechanism `findRelevantMemories`
 * and the wiki distiller use. The safety properties are the ones this codebase
 * arrived at the hard way:
 *
 *   - every point cites the commit hashes it came from, and a citation that
 *     does not resolve is treated as no citation at all;
 *   - producing nothing is a reported failure, never a templated filler line;
 *   - the diff budget is explicit, so a huge commit truncates visibly instead
 *     of silently crowding out the rest of the batch.
 */

import { z } from 'zod/v4'
import { getDefaultSonnetModel } from '../../utils/model/model.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonParse } from '../../utils/slowOperations.js'

export const knowledgePointSchema = z.object({
  point: z.string(),
  evidence: z.string().default(''),
  commits: z.array(z.string()).default([]),
})

export type KnowledgePoint = z.infer<typeof knowledgePointSchema>

export type ExtractedKnowledge = {
  ok: boolean
  domain: KnowledgePoint[]
  coding: KnowledgePoint[]
  /** Points discarded for citing commits that are not in this batch. */
  dropped: string[]
  error?: string
}

/**
 * Per-batch patch budget. A lecture covers up to a handful of commits; sending
 * an unbounded diff would blow the context and let one 10k-line vendored-deps
 * commit crowd out the four commits that actually carry meaning.
 */
export const DIFF_BUDGET_CHARS = 24_000
const PER_COMMIT_BUDGET_CHARS = 8_000

/**
 * Assemble the patch text for a batch, bounded both per-commit and overall.
 *
 * Truncation is marked inline rather than silent: a reader (and the model)
 * must be able to tell that a commit was cut off, otherwise an absent change
 * is indistinguishable from a change that was never shown.
 */
export function buildDiffCorpus(
  patches: ReadonlyArray<{ shortHash: string; subject: string; patch: string }>,
  budget = DIFF_BUDGET_CHARS,
): string {
  const parts: string[] = []
  let used = 0

  for (const p of patches) {
    if (used >= budget) {
      parts.push(`### ${p.shortHash} ${p.subject}\n[omitted: batch diff budget exhausted]`)
      continue
    }
    const perCommit = Math.min(PER_COMMIT_BUDGET_CHARS, budget - used)
    const body =
      p.patch.length > perCommit
        ? `${p.patch.slice(0, perCommit)}\n[…truncated ${p.patch.length - perCommit} chars of this commit's diff]`
        : p.patch
    parts.push(`### ${p.shortHash} ${p.subject}\n\n\`\`\`diff\n${body}\n\`\`\``)
    used += body.length
  }

  return parts.join('\n\n')
}

const SYSTEM = `You are writing the knowledge sections of a lecture that walks a reader through a repository's commit history.

You receive the actual patches for one batch of commits. Produce two kinds of point:

- DOMAIN knowledge: what this code is about in its problem domain. The business rules,
  invariants, formulas, protocols, edge cases and vocabulary the diff reveals. "This
  repository does quantitative trading" is not domain knowledge; "positions are marked
  to market using the previous close when the current bar is missing" is.
- CODING knowledge: transferable engineering technique visible in the diff. Structure,
  error handling, data-flow and API-design choices, and why they were made this way.

Hard rules:
- Every point MUST cite the short hashes it came from, in "commits", using exactly the
  hashes given to you. A point you cannot tie to a commit is a point you must not emit.
- Read the diff. Do not infer from filenames, and do not restate the commit message.
- "evidence" quotes or names the specific thing in the patch that supports the point —
  a function, a constant, a changed line.
- Do not pad. Three points grounded in the patch beat ten generic ones. If this batch
  is a rename, a version bump or a formatting pass, say so with one point and stop.
- If the diff genuinely reveals no domain knowledge, return an empty domain array.
  Never emit a placeholder like "the domain semantics are weak here".`

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    domain: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          evidence: { type: 'string' },
          commits: { type: 'array', items: { type: 'string' } },
        },
        required: ['point', 'evidence', 'commits'],
        additionalProperties: false,
      },
    },
    coding: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          evidence: { type: 'string' },
          commits: { type: 'array', items: { type: 'string' } },
        },
        required: ['point', 'evidence', 'commits'],
        additionalProperties: false,
      },
    },
  },
  required: ['domain', 'coding'],
  additionalProperties: false,
} as const

export async function extractKnowledge(params: {
  repoName: string
  patches: ReadonlyArray<{ shortHash: string; subject: string; patch: string }>
  signal: AbortSignal
}): Promise<ExtractedKnowledge> {
  if (params.patches.length === 0) {
    return { ok: false, domain: [], coding: [], dropped: [], error: 'no commits in batch' }
  }

  const corpus = buildDiffCorpus(params.patches)
  if (!corpus.trim()) {
    return { ok: false, domain: [], coding: [], dropped: [], error: 'no diff content available for this batch' }
  }

  const known = new Set(params.patches.map(p => p.shortHash))

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SYSTEM,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Repository: ${params.repoName}\nCommits in this batch: ${[...known].join(', ')}\n\n${corpus}`,
        },
      ],
      max_tokens: 3072,
      output_format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      signal: params.signal,
      querySource: 'redo_knowledge',
    })
    const text = result.content.find(b => b.type === 'text')
    if (!text || text.type !== 'text') {
      return { ok: false, domain: [], coding: [], dropped: [], error: 'extraction returned no text block' }
    }
    return validateKnowledge(jsonParse(text.text), known)
  } catch (e) {
    return {
      ok: false,
      domain: [],
      coding: [],
      dropped: [],
      error: `extraction call failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Keep only points whose cited commits are actually in this batch.
 *
 * Split from the network call so every rejection path is testable. A hallucinated
 * hash is treated exactly like a missing one: the citation exists so a reader can
 * check it, and one that does not resolve has not been checked.
 */
export function validateKnowledge(raw: unknown, knownHashes: ReadonlySet<string>): ExtractedKnowledge {
  const parsed = z
    .object({ domain: z.array(z.unknown()).default([]), coding: z.array(z.unknown()).default([]) })
    .safeParse(raw)

  if (!parsed.success) {
    return { ok: false, domain: [], coding: [], dropped: [], error: 'extraction output did not match the expected shape' }
  }

  const dropped: string[] = []

  const clean = (items: unknown[]): KnowledgePoint[] =>
    items
      .map(i => knowledgePointSchema.safeParse(i))
      .filter(r => r.success)
      .map(r => r.data!)
      .filter(p => {
        if (!p.point.trim()) return false
        // Hashes may be cited at any prefix length; match either direction so a
        // 7-char citation resolves against an 8-char batch hash and vice versa.
        const resolved = p.commits.filter(c =>
          [...knownHashes].some(k => k.startsWith(c) || c.startsWith(k)),
        )
        if (resolved.length === 0) {
          dropped.push(`${p.point.slice(0, 60)} (no resolvable commit)`)
          return false
        }
        p.commits = resolved
        return true
      })

  const domain = clean(parsed.data.domain)
  const coding = clean(parsed.data.coding)

  if (domain.length === 0 && coding.length === 0) {
    return {
      ok: false,
      domain: [],
      coding: [],
      dropped,
      error:
        dropped.length > 0
          ? `every extracted point cited a commit outside this batch (${dropped.length} dropped)`
          : 'extraction produced no points',
    }
  }

  return { ok: true, domain, coding, dropped }
}

/** Render a knowledge section, or an explicit "not extracted" note. */
export function renderKnowledgeSection(points: readonly KnowledgePoint[], emptyNote: string): string {
  if (points.length === 0) return `_${emptyNote}_`
  return points
    .map(p => {
      const cites = p.commits.length > 0 ? ` [${p.commits.join(', ')}]` : ''
      const evidence = p.evidence.trim() ? `\n  - 依据：${p.evidence.trim()}` : ''
      return `- ${p.point}${cites}${evidence}`
    })
    .join('\n')
}
