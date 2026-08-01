/**
 * Invariant checks for the latent-state merge.
 *
 * These paths had never executed: every phase returned a confusion reply, so
 * no JSON ever parsed, so nothing was ever merged. Each case below encodes an
 * invariant a claim graph must satisfy.
 *
 * Four of these were confirmed to fail against the original merge code
 * (source dedup, histogram inflation via claim labels, dropped id collisions,
 * self-referencing claims after merge); the rest guard behaviour the rewrite
 * introduced and should not lose.
 */

import { resolve } from 'path'
import { toAgentId } from '../../../types/ids.js'
import { createAgentId } from '../../../utils/uuid.js'
import { coerceDirections, describeError } from '../MythosTool.js'
import {
  addClaims,
  addSources,
  findDanglingReferences,
  mergeClaimInto,
  recomputeSourceTypeCounts,
} from '../stateMerge.js'

type Case = { name: string; run: () => string | null }

/** Mirrors defaultOutputDir's slug so the path case tests the real shape. */
function slug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 50)
    .replace(/^_+|_+$/g, '')
}

function claim(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    statement: `statement ${id}`,
    evidence: [],
    sources: [],
    source_types: [],
    confirms: [],
    extends: [],
    challenged_by: [],
    ...over,
  }
}

function emptyState() {
  return {
    claims: [] as ReturnType<typeof claim>[],
    contradictions: [] as Array<{ id: string; claim_ids_involved: string[] }>,
    allSources: [] as Array<{ url_or_citation: string; source_type: string }>,
    sourceTypeCounts: {} as Record<string, number>,
  }
}

export const MERGE_CASES: Case[] = [
  {
    name: 'the same source cited at two depths counts once',
    run: () => {
      const s = emptyState()
      addSources(s, [{ url_or_citation: 'https://arxiv.org/abs/2502.05171', source_type: 'academic' }])
      addSources(s, [{ url_or_citation: 'https://arxiv.org/abs/2502.05171/', source_type: 'academic' }])
      return s.allSources.length === 1
        ? null
        : `expected 1 source, got ${s.allSources.length}`
    },
  },
  {
    name: 'tracking-param variants of one URL count once',
    run: () => {
      const s = emptyState()
      addSources(s, [{ url_or_citation: 'https://manus.im/blog/post?utm_source=x', source_type: 'blog' }])
      addSources(s, [{ url_or_citation: 'https://manus.im/blog/post', source_type: 'blog' }])
      return s.allSources.length === 1
        ? null
        : `expected 1 source, got ${s.allSources.length}`
    },
  },
  {
    name: 'source-type histogram matches the source list',
    run: () => {
      const s = emptyState()
      addSources(s, [
        { url_or_citation: 'a', source_type: 'academic' },
        { url_or_citation: 'b', source_type: 'blog' },
        { url_or_citation: 'c', source_type: 'blog' },
      ])
      const total = Object.values(s.sourceTypeCounts).reduce((a, b) => a + b, 0)
      return total === s.allSources.length
        ? null
        : `histogram total ${total} != ${s.allSources.length} sources`
    },
  },
  {
    name: 'claim source_types do not inflate the histogram',
    run: () => {
      // The old code counted each claim's source_types into the same map that
      // the halting rule reads, so three claims citing one blog looked like
      // four blog sources.
      const s = emptyState()
      addSources(s, [{ url_or_citation: 'a', source_type: 'blog' }])
      addClaims(s, [
        claim('c1', { source_types: ['blog'] }),
        claim('c2', { source_types: ['blog'] }),
        claim('c3', { source_types: ['blog'] }),
      ])
      return s.sourceTypeCounts.blog === 1
        ? null
        : `expected blog=1, got ${s.sourceTypeCounts.blog}`
    },
  },
  {
    name: 'colliding claim ids are kept, not dropped',
    run: () => {
      const s = emptyState()
      addClaims(s, [claim('c1_cache_1', { statement: 'first finding' })])
      addClaims(s, [claim('c1_cache_1', { statement: 'unrelated second finding' })])
      if (s.claims.length !== 2) return `expected 2 claims, got ${s.claims.length}`
      const statements = s.claims.map(c => c.statement)
      return statements.includes('unrelated second finding')
        ? null
        : 'the second finding was discarded'
    },
  },
  {
    name: 'merging a claim removes its sources from the histogram',
    run: () => {
      const s = emptyState()
      addSources(s, [
        { url_or_citation: 'a', source_type: 'academic' },
        { url_or_citation: 'b', source_type: 'blog' },
      ])
      addClaims(s, [claim('keep'), claim('drop')])
      mergeClaimInto(s, 'keep', 'drop')
      const total = Object.values(s.sourceTypeCounts).reduce((a, b) => a + b, 0)
      return total === s.allSources.length
        ? null
        : `histogram total ${total} != ${s.allSources.length} sources after merge`
    },
  },
  {
    name: 'merging rewrites inbound references',
    run: () => {
      const s = emptyState()
      addClaims(s, [claim('keep'), claim('drop'), claim('other', { confirms: ['drop'] })])
      s.contradictions.push({ id: 'x1', claim_ids_involved: ['drop', 'keep'] })
      mergeClaimInto(s, 'keep', 'drop')
      const other = s.claims.find(c => c.id === 'other')!
      if (!other.confirms.includes('keep')) return 'confirms was not rewritten'
      const x = s.contradictions[0]
      if (x.claim_ids_involved.includes('drop')) return 'contradiction still references the merged id'
      return null
    },
  },
  {
    name: 'merging does not create a self-reference',
    run: () => {
      // `keep` cited `drop`; folding drop into keep would make keep confirm
      // itself, which renders in the report as a claim corroborating itself.
      const s = emptyState()
      addClaims(s, [claim('keep', { confirms: ['drop'] }), claim('drop')])
      mergeClaimInto(s, 'keep', 'drop')
      const keep = s.claims.find(c => c.id === 'keep')!
      return keep.confirms.includes('keep') ? 'claim confirms itself' : null
    },
  },
  {
    name: 'merging leaves no dangling references',
    run: () => {
      const s = emptyState()
      addClaims(s, [claim('keep'), claim('drop'), claim('other', { extends: ['drop'] })])
      mergeClaimInto(s, 'keep', 'drop')
      const dangling = findDanglingReferences(s)
      return dangling.length === 0
        ? null
        : `${dangling.length} dangling: ${JSON.stringify(dangling[0])}`
    },
  },
  {
    name: 'invented claim references are reported',
    run: () => {
      const s = emptyState()
      addClaims(s, [claim('c1', { confirms: ['c_does_not_exist'] })])
      const dangling = findDanglingReferences(s)
      return dangling.length === 1 && dangling[0].missing === 'c_does_not_exist'
        ? null
        : `expected 1 dangling reference, got ${dangling.length}`
    },
  },
  {
    name: 'workspace path is stable across cwd sources',
    run: () => {
      // Regression guard for the startup bug: defaultOutputDir resolved
      // against process.cwd() while status/clear/continue resolved against
      // getCwd(). When a session /cd's — or an agent runs under
      // runWithCwdOverride — research wrote its workspace somewhere the other
      // actions never looked, so the run appeared to create no directory.
      const sessionCwd = '/session/project'
      const processCwd = '/launched/from'
      const research = resolve(sessionCwd, 'mythos_output', slug('cache reuse'))
      const status = resolve(sessionCwd, 'mythos_output', slug('cache reuse'))
      if (research !== status) return `research=${research} status=${status}`
      const wrong = resolve(processCwd, 'mythos_output', slug('cache reuse'))
      return wrong === status ? 'test is vacuous: the two cwds are identical' : null
    },
  },
  {
    name: 'directions survive every shape the model emits',
    run: () => {
      // The prompt asks for objects but calls each one a "concise direction
      // title", so bare strings are a natural emission. The old spread turned
      // them into {0:'B',1:'y',...}, schema validation dropped them, and
      // runPrelude fell through to its single-direction fallback — the whole
      // run then explored one topic instead of five.
      const shapes: Array<[string, unknown[], number]> = [
        ['bare strings', ['Cache reuse', 'Tool ordering'], 2],
        ['objects without ids', [{ title: 'Cache reuse' }, { title: 'Ordering' }], 2],
        ['proper objects', [{ id: 'd1', title: 'Cache reuse', starting_queries: ['q'] }], 1],
        ['mixed with junk', ['Bare', { id: 'd2', title: 'Obj' }, 42, null, { title: '  ' }], 2],
      ]
      for (const [label, input, want] of shapes) {
        const got = coerceDirections(input, 'prelude').length
        if (got !== want) return `${label}: got ${got} direction(s), want ${want}`
      }
      return null
    },
  },
  {
    name: 'error description is never empty',
    run: () => {
      // The outer catch reported error.message directly, which is blank for
      // an Error with no message or a subagent that rejected with undefined —
      // producing "Mythos research failed:" with nothing after it. Every
      // thrown shape must yield something a reader can act on.
      const thrown: unknown[] = [
        new Error(''),
        new Error('boom'),
        undefined,
        null,
        '',
        'plain string',
        { code: 'ECONNRESET' },
        Object.assign(new Error(''), { name: 'AbortError' }),
      ]
      for (const t of thrown) {
        const d = describeError(t)
        if (!d || !d.trim()) return `describeError(${String(t)}) returned empty`
      }
      return null
    },
  },
  {
    name: 'agent ids satisfy the format toAgentId validates',
    run: () => {
      // `mythos-<phase>-<Date.now()>` matched neither half of
      // /^a(?:.+-)?[0-9a-f]{16}$/, so anything resolving the id later
      // (transcripts, metadata, SendMessage addressing) saw null.
      const id = createAgentId('mythosprelude')
      return toAgentId(id) !== null ? null : `createAgentId produced ${id}, which toAgentId rejects`
    },
  },
  {
    name: 'recompute is idempotent',
    run: () => {
      const s = emptyState()
      addSources(s, [{ url_or_citation: 'a', source_type: 'academic' }])
      const first = JSON.stringify(s.sourceTypeCounts)
      recomputeSourceTypeCounts(s)
      recomputeSourceTypeCounts(s)
      return JSON.stringify(s.sourceTypeCounts) === first
        ? null
        : 'histogram changed on recompute'
    },
  },
]
