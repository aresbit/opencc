/**
 * Okapi BM25 over the local skill/lesson corpus.
 *
 * Why not the Jaccard overlap already in `rsi/distill.ts`: that scores a
 * document by the *fraction of the query's vocabulary it happens to share*, so
 * a three-word query and a three-hundred-word lesson are compared on the same
 * footing as two documents of equal size. It has no notion of a term being
 * rare, and no notion of a document being long, which are exactly the two
 * signals that decide a ranking over a mixed library of one-line skill
 * descriptions and multi-paragraph lessons.
 *
 * BM25 fixes both with two factors that are standard and well understood:
 *   - IDF (the `log(1 + (N - df + 0.5)/(df + 0.5))` form) makes a term that
 *     appears in every document worth almost nothing and a term that appears in
 *     one worth a lot. "robot" ranks nothing; "Nédelec" ranks the right thing.
 *   - Document-length normalisation (`b`) stops a long lesson from out-scoring a
 *     concise skill just by containing more words that overlap the query.
 *
 * The tokeniser is the one non-standard part, and it exists because the corpus
 * is bilingual. A word-based tokeniser returns a single enormous token for a
 * Chinese sentence and then reports every pair of Chinese documents as
 * completely unrelated — which would defeat retrieval precisely in a repository
 * whose notes are written in Chinese. CJK runs are therefore cut into character
 * bigrams (the standard approach for languages without word delimiters), while
 * latin text stays word-based and is additionally split on `._/-` so that
 * `skill-search` still matches `search`.
 *
 * Nothing here touches the filesystem or the network. It is a pure function of
 * (documents, query) so it can be evaluated on a held-out set in a test.
 */

/** Term-frequency saturation. 1.2 is the value in the original Okapi work. */
export const BM25_K1 = 1.2
/** Length-normalisation strength. 0.75 is the value in the original Okapi work. */
export const BM25_B = 0.75

export interface Bm25Doc {
  id: string
  text: string
}

export interface Bm25Index {
  ids: string[]
  /** token -> (document index -> term frequency) */
  postings: Map<string, Map<number, number>>
  /** token -> number of documents containing it */
  df: Map<string, number>
  docLen: number[]
  avgDocLen: number
  N: number
}

export interface Bm25Hit {
  docIndex: number
  id: string
  score: number
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const LATIN_SPLIT = /[._/-]+/

/**
 * Tokenise into a *sequence* (repetitions preserved), so the caller can count
 * term frequencies. Output is lowercased.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const word of lower.split(/[^\p{L}\p{N}_./-]+/u)) {
    if (word.length === 0) continue
    if (CJK.test(word)) {
      const chars = [...word]
      if (chars.length === 1) {
        tokens.push(chars[0]!)
        continue
      }
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(`${chars[i]}${chars[i + 1]}`)
      }
    } else {
      if (word.length < 2) continue
      tokens.push(word)
      // Compound identifiers contribute their parts too: "repo-to-skill"
      // should be reachable by "skill" or "repo".
      const parts = word.split(LATIN_SPLIT)
      if (parts.length > 1) {
        for (const part of parts) {
          if (part.length >= 2) tokens.push(part)
        }
      }
    }
  }
  return tokens
}

export function buildBm25(docs: readonly Bm25Doc[]): Bm25Index {
  const ids = docs.map(d => d.id)
  const postings = new Map<string, Map<number, number>>()
  const docLen: number[] = new Array(docs.length).fill(0)
  let totalLen = 0

  docs.forEach((doc, i) => {
    const toks = tokenize(doc.text)
    docLen[i] = toks.length
    totalLen += toks.length
    const tf = new Map<string, number>()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [t, count] of tf) {
      let bucket = postings.get(t)
      if (!bucket) {
        bucket = new Map()
        postings.set(t, bucket)
      }
      bucket.set(i, count)
    }
  })

  const df = new Map<string, number>()
  for (const [t, bucket] of postings) df.set(t, bucket.size)

  return {
    ids,
    postings,
    df,
    docLen,
    avgDocLen: docs.length === 0 ? 0 : totalLen / docs.length,
    N: docs.length,
  }
}

/**
 * Score every document against the query. Query terms are deduplicated: a term
 * repeated in the query is one query term, not a heavier one.
 */
export function bm25ScoreAll(index: Bm25Index, query: string): number[] {
  const scores: number[] = new Array(index.N).fill(0)
  if (index.N === 0) return scores
  const queryTerms = new Set(tokenize(query))
  if (queryTerms.size === 0) return scores

  const avg = index.avgDocLen || 1
  for (const term of queryTerms) {
    const bucket = index.postings.get(term)
    if (!bucket) continue
    const df = index.df.get(term) ?? 0
    // The +0.5 form keeps IDF non-negative even for a term in every document,
    // unlike the classic plain log(N/df) which would subtract score.
    const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5))
    for (const [i, tf] of bucket) {
      const norm = 1 - BM25_B + BM25_B * (index.docLen[i]! / avg)
      scores[i] += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm)
    }
  }
  return scores
}

/**
 * Top-k documents by BM25 score, dropping zero-score documents.
 *
 * Ties break on document index so the ranking is deterministic — a retrieval
 * result that reshuffles between two identical runs cannot be used as a
 * measurement.
 */
export function bm25Search(
  index: Bm25Index,
  query: string,
  k: number,
): Bm25Hit[] {
  const scores = bm25ScoreAll(index, query)
  const hits: Bm25Hit[] = []
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i]!
    if (score > 0) hits.push({ docIndex: i, id: index.ids[i]!, score })
  }
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.docIndex - b.docIndex))
  return hits.slice(0, Math.max(0, k))
}

/**
 * A name-substring baseline, for evaluating BM25 against something.
 *
 * This is the ranking a naive implementation reaches for: a document is
 * relevant when a query term literally appears in its *name*. It is cheap,
 * needs no index, and works well when the query happens to contain the skill's
 * name — which is exactly why it is the comparison that matters. If BM25 cannot
 * beat it, BM25 is not earning its complexity.
 */
export function substringNameSearch(
  docs: readonly { id: string; name: string }[],
  query: string,
  k: number,
): { id: string; score: number }[] {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return []
  const scored = docs.map((doc, i) => {
    const name = doc.name.toLowerCase()
    let score = 0
    for (const term of queryTerms) if (name.includes(term)) score += 1
    return { id: doc.id, score, i }
  })
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i))
    .slice(0, Math.max(0, k))
    .map(({ id, score }) => ({ id, score }))
}
