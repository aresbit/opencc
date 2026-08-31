import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../MemoryStore.js'
import {
  buildQueryContext,
  charNgrams,
  RANKING,
  scoreMemory,
  staleTimestamp,
  tokenizeQuery,
} from '../ranking.js'

/**
 * The eval harness in ./eval scores retrieval, and it is the right tool for
 * "did this weight help". It cannot see everything, though: its MRR averages
 * the reciprocal rank of every expected memory, so [a, b] and [b, a] score
 * identically even though `expected` is documented as best-first. Staleness is
 * exactly an ordering property, so it is pinned here instead.
 */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function store(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), 'memtest-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}

const memory = (over: Partial<Record<string, unknown>>) =>
  ({
    id: 'x',
    type: 'project',
    name: '',
    description: '',
    content: '',
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    filePath: '',
    ...over,
  }) as never

describe('staleness demotes rather than removes', () => {
  test('a stale memory drops below a fresh one it would otherwise outrank', async () => {
    const s = store()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    // The stale one is the *better* exact match; only the demotion reorders them.
    await s.saveMemory('project', 'Kafka consumer lag', 'incident mitigation', 'body', [], past)
    await s.saveMemory('project', 'Partition rebalance for consumer lag', 'kafka permanent fix', 'body', [])

    const hits = await s.searchMemories('kafka consumer lag', undefined, 5)
    const names = hits.map(h => h.name)
    expect(names).toHaveLength(2)
    expect(names[0]).toBe('Partition rebalance for consumer lag')
    // Still findable — demoted, not filtered.
    expect(names[1]).toBe('Kafka consumer lag')
  })

  test('archiveOldMemories leaves a fresh-but-stale memory alone', async () => {
    // The two flags mean different things: stale_after demotes in search,
    // archiving takes the memory out of the searchable set. A memory written
    // today must not be archived by a 365-day request just because it carries
    // the flag.
    const s = store()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    await s.saveMemory('project', 'flagged', 'stale but written today', 'body', [], past)

    const { archived } = await s.archiveOldMemories(365)
    expect(archived).toBe(0)
    expect(await s.searchMemories('flagged', undefined, 5)).toHaveLength(1)
  })

  test('include_stale is how you actually archive one', async () => {
    const s = store()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    await s.saveMemory('project', 'flagged', 'stale but written today', 'body', [], past)
    await s.saveMemory('project', 'unflagged', 'no stale date', 'body', [])

    const { archived } = await s.archiveOldMemories(365, { includeStale: true })
    expect(archived).toBe(1)
    expect((await s.searchMemories('flagged unflagged', undefined, 5)).map(m => m.name)).toEqual(['unflagged'])
  })
})

describe('an unparseable stale_after', () => {
  test('reads as never stale, in one place, for both consumers', () => {
    expect(staleTimestamp('next week')).toBe(Number.POSITIVE_INFINITY)
    expect(staleTimestamp('2020-01-01T00:00:00.000Z')).toBe(1577836800000)
    // NaN would have made `now > stale` false and `stale < now` false too —
    // right by accident in both places, and wrong the moment either comparison
    // is written the other way round.
    const terms = tokenizeQuery('garbage', RANKING)
    const m = memory({ name: 'garbage', staleAfter: 'next week' })
    const fresh = memory({ name: 'garbage' })
    expect(scoreMemory(m, terms, RANKING)).toBe(scoreMemory(fresh, terms, RANKING))
  })
})

describe('the soft match', () => {
  test('rescues a run-together query that exact matching misses', () => {
    // The case that justifies the signal at all: no separator, so the query is
    // one term and `includes` finds nothing.
    const terms = tokenizeQuery('feishuapi', RANKING)
    const m = memory({ name: 'feishu_api rate limit handling' })
    expect(scoreMemory(m, terms, RANKING)).toBe(0)
    expect(
      scoreMemory(m, terms, RANKING, buildQueryContext('feishuapi', RANKING)),
    ).toBeGreaterThan(0)
  })

  test('adds nothing for CJK, which bigram tokenization already covers', () => {
    // Documents why charNgrams stays at n=3 rather than growing a CJK knob.
    for (const [query, name] of [
      ['鉴权', '飞书鉴权流程'],
      ['缓存失效', '缓存无效化策略'],
      ['降噪训练', 'RNNoise 降噪模型训练进展'],
    ] as const) {
      const terms = tokenizeQuery(query, RANKING)
      const m = memory({ name })
      const exact = scoreMemory(m, terms, RANKING)
      expect(exact).toBeGreaterThan(0)
      expect(scoreMemory(m, terms, RANKING, buildQueryContext(query, RANKING))).toBe(exact)
    }
  })

  test('charNgrams keeps the same CJK range the tokenizer uses', () => {
    // U+3400 Extension A: tokenized as CJK by tokenizeQuery, so it must not be
    // stripped to nothing here.
    expect(tokenizeQuery('㐀㐁㐂', RANKING).length).toBeGreaterThan(0)
    expect(charNgrams('㐀㐁㐂', 3).size).toBeGreaterThan(0)
  })

  test('the query grams are built once, not per memory', () => {
    // scoreMemory takes a prepared context; passing a query string per
    // candidate is what the signature no longer allows.
    const ctx = buildQueryContext('deepseek prefix cache', RANKING)
    expect(ctx.grams.size).toBeGreaterThan(0)
    const terms = tokenizeQuery('deepseek prefix cache', RANKING)
    const m = memory({ name: 'DeepSeek byte-level prefix cache optimization' })
    expect(scoreMemory(m, terms, RANKING, ctx)).toBeGreaterThan(0)
  })
})
