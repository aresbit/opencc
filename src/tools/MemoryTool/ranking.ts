/**
 * Retrieval ranking for MemoryTool.
 *
 * Split out of MemoryStore so the scoring parameters are a value, not a set
 * of magic numbers buried in a method. `RANKING` is mutable on purpose: the
 * eval harness in ./eval sweeps it to find better weights, which is the only
 * way to know whether a change to retrieval actually helped. Without that,
 * tuning these numbers is just taste.
 *
 * See ./eval/README.md for the metric and the current best-known settings.
 */

import type { Memory } from './MemoryStore.js'

export type RankingConfig = {
  /** Field weights: a hit in a curated field means more than one in the body. */
  nameWeight: number
  tagWeight: number
  descriptionWeight: number
  contentWeight: number
  /**
   * Multiplier applied to memories tagged `overcome` — beliefs that `evolve`
   * has superseded. They are demoted rather than filtered: the successor
   * should win, but the genealogy has to stay reachable, otherwise "we used
   * to think X and changed our mind because Y" is unrecoverable.
   */
  overcomeFactor: number
  /** Whether CJK runs are expanded into overlapping bigrams. */
  cjkBigrams: boolean
  /** Minimum length for a Latin term to count. */
  minTermLength: number
  /**
   * Weight of the character n-gram Dice soft-match. Exact term hits in a
   * curated field dominate; the soft match is a weaker signal for partial /
   * boundary-blurred matches that `includes` misses (e.g. `feishu` vs
   * `feishu_api`).
   */
  softMatchWeight: number
  /** Minimum Dice coefficient for the soft match to score at all. */
  softMatchThreshold: number
  /**
   * Multiplier applied to memories whose `staleAfter` has passed — beliefs the
   * user marked as having a finite lifetime. Demoted rather than filtered, so
   * the memory stays reachable but no longer competes at full weight with
   * fresh ones.
   */
  staleFactor: number
}

export const RANKING: RankingConfig = {
  nameWeight: 8,
  tagWeight: 5,
  descriptionWeight: 4,
  contentWeight: 1,
  // 0.6 came out of the sweep (see ./eval/CHANGELOG.md), not from taste.
  // The interesting datapoint is the other end: overcomeFactor = 1 — i.e. no
  // demotion at all — scores 0.9325 against 0.9667, so superseded beliefs
  // resurfacing at full weight is a measurable regression, not a theoretical
  // one. The margin between 0.35 and 0.6 is thin enough to be one case.
  overcomeFactor: 0.6,
  cjkBigrams: true,
  minTermLength: 2,
  // Soft match and staleness are additive signals; the defaults below are
  // deliberately conservative so exact term hits keep dominating. Tune via the
  // eval harness (./eval) rather than by taste.
  softMatchWeight: 3,
  softMatchThreshold: 0.3,
  staleFactor: 0.5,
}

/**
 * Words that appear in almost every memory and in almost every query. Left in,
 * they make every memory a match for any conversational query.
 */
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'how',
  'what', 'why', 'when', 'where', 'which', 'who', 'this', 'that', 'these',
  'those', 'it', 'its', 'we', 'i', 'you', 'my', 'our', 'me', 'about', 'from',
  'can', 'should', 'would', 'will', 'have', 'has', 'had', 'not', 'use', 'using',
])

const CJK = /[㐀-鿿぀-ヿ]/
const CJK_RUN = /[㐀-鿿぀-ヿ]+/gu

/**
 * Character n-grams of a string, on the alphanumeric + Han/Kana alphabet only
 * (punctuation/whitespace stripped). Used for the soft match: a Dice overlap
 * of query grams against a field's grams catches partial and boundary-blurred
 * hits that exact `includes` on tokenized terms misses.
 */
export function charNgrams(s: string, n: number): Set<string> {
  const grams = new Set<string>()
  const clean = s.toLowerCase().replace(/[^a-z0-9一-鿿぀-ヿ]/g, '')
  for (let i = 0; i + n <= clean.length; i++) {
    grams.add(clean.slice(i, i + n))
  }
  return grams
}

/** Sørensen–Dice coefficient between two gram sets. */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return (2 * inter) / (a.size + b.size)
}

/**
 * Split a query into search terms.
 *
 * Latin text splits on whitespace/punctuation; CJK has no spaces, so runs of
 * Han/Kana characters are additionally emitted as overlapping bigrams —
 * "记忆工具" yields 记忆 / 忆工 / 工具, which is what actually matches stored
 * Chinese text. Splitting on whitespace alone yields one long token that
 * matches nothing, which is why Chinese recall used to return empty.
 */
export function tokenizeQuery(
  query: string,
  config: RankingConfig = RANKING,
): string[] {
  const terms = new Set<string>()

  for (const word of query.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!word) continue
    if (CJK.test(word)) {
      for (const run of word.match(CJK_RUN) ?? []) {
        if (run.length === 1 || !config.cjkBigrams) {
          terms.add(run)
          continue
        }
        for (let i = 0; i + 2 <= run.length; i++) {
          terms.add(run.slice(i, i + 2))
        }
      }
      // Latin fragments embedded in a CJK run (e.g. "deepseek缓存").
      for (const latin of word.match(/[a-z0-9_]{2,}/g) ?? []) {
        if (!STOPWORDS.has(latin)) terms.add(latin)
      }
      continue
    }
    if (word.length < config.minTermLength || STOPWORDS.has(word)) continue
    terms.add(word)
  }

  return [...terms]
}

/**
 * Field-weighted term frequency. Name and tags are curated and short, so a hit
 * there is a much stronger signal than a hit somewhere in the body.
 */
export function scoreMemory(
  memory: Memory,
  terms: string[],
  config: RankingConfig = RANKING,
  query: string = '',
): number {
  const name = memory.name.toLowerCase()
  const description = memory.description.toLowerCase()
  const tags = (memory.tags ?? []).join(' ').toLowerCase()
  const content = memory.content.toLowerCase()

  let score = 0
  for (const term of terms) {
    if (name.includes(term)) score += config.nameWeight
    if (tags.includes(term)) score += config.tagWeight
    if (description.includes(term)) score += config.descriptionWeight
    if (content.includes(term)) score += config.contentWeight
  }

  // Soft match: character n-gram Dice against name/description. Catches
  // partial and boundary-blurred hits that exact `includes` misses, and can
  // rescue a memory that otherwise scores zero (the whole point of a soft
  // signal). name counts more than description — it is the curated, dense
  // field.
  if (query && config.softMatchWeight > 0) {
    const qGrams = charNgrams(query, 3)
    if (qGrams.size > 0) {
      const nameDice = dice(qGrams, charNgrams(name, 3))
      if (nameDice >= config.softMatchThreshold) {
        score += config.softMatchWeight * nameDice
      }
      const descDice = dice(qGrams, charNgrams(description, 3))
      if (descDice >= config.softMatchThreshold) {
        score += config.softMatchWeight * descDice * 0.5
      }
    }
  }

  if (score > 0 && memory.tags?.includes('overcome')) {
    score *= config.overcomeFactor
  }
  // Stale memories: demote, don't filter — the belief stays reachable but no
  // longer competes at full weight with fresh ones.
  if (score > 0 && memory.staleAfter) {
    const staleTime = new Date(memory.staleAfter).getTime()
    if (!Number.isNaN(staleTime) && Date.now() > staleTime) {
      score *= config.staleFactor
    }
  }
  return score
}
