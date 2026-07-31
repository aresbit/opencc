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

  if (score > 0 && memory.tags?.includes('overcome')) {
    score *= config.overcomeFactor
  }
  return score
}
