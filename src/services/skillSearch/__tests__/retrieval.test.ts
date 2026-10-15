import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { Command } from '../../../types/command.js'
import {
  buildSkillDocs,
  buildSkillIndex,
  extraSkillRoots,
  isArchivedPath,
  loadSkillDocsFromRoot,
  mergeSkillDocs,
  searchDocs,
  type SkillDoc,
} from '../localSearch.js'
import { substringNameSearch } from '../bm25.js'
import type { Lesson } from '../../rsi/distill.js'

/**
 * The claim this whole feature rests on is "BM25 finds things name-matching
 * does not". That is a measurable claim, and this file is where it is measured
 * rather than asserted.
 *
 * The comparison is against `substringNameSearch` — the ranking a naive
 * implementation reaches for: a doc is relevant when a query term literally
 * appears in its *name*. It is not a straw man. It is cheap, needs no index,
 * and wins outright whenever the query contains the skill's name, which is
 * exactly the case a user hitting Tab-completion is in. If BM25 cannot beat it
 * on a held-out set, BM25 is not earning its complexity.
 *
 * ── The held-out set ─────────────────────────────────────────────────────
 *
 * Eleven documents, six queries, each with a known relevant document. The set
 * is deliberately mixed: two queries name their target (the baseline wins
 * those), four reach it only through the description or a different language
 * (the baseline cannot see it at all). The queries and the relevance labels
 * are fixed here and were not tuned against the ranking.
 *
 * ── What is measured ─────────────────────────────────────────────────────
 *
 * Recall@5 (was the relevant doc in the top five at all) and MRR (how high it
 * ranked). The gate is conjunctive: BM25's Recall@5 must be at least the
 * baseline's, AND its MRR must be strictly greater. "At least" on recall
 * because losing a document the baseline found would be a regression even if
 * the ranking improved elsewhere; "strictly greater" on MRR because a tie
 * would mean the extra machinery bought nothing.
 */

const CORPUS: SkillDoc[] = [
  {
    id: 'skill:docx',
    kind: 'skill',
    name: 'docx',
    text: 'docx\nCreate and edit Word documents; convert to and from markdown; templates and styles.',
    sourcePath: '/skills/docx',
  },
  {
    id: 'skill:pdf',
    kind: 'skill',
    name: 'pdf',
    text: 'pdf\nRender, split, merge, extract text and images from PDF files; LaTeX to PDF.',
    sourcePath: '/skills/pdf',
  },
  {
    id: 'skill:humanizer',
    kind: 'skill',
    name: 'humanizer',
    text: 'humanizer\nRemove AI tells from prose; vary sentence rhythm; strip em-dash flourishes and tricolon lists.',
    sourcePath: '/skills/humanizer',
  },
  {
    id: 'skill:manuscript-check',
    kind: 'skill',
    name: 'manuscript-check',
    text: 'manuscript-check\nCheck fiction chapters for AI writing traces, dialogue ratio, sensory balance, foreshadowing payoff.',
    sourcePath: '/skills/manuscript-check',
  },
  {
    id: 'skill:skill-search',
    kind: 'skill',
    name: 'skill-search',
    text: 'skill-search\nOkapi BM25 ranking over skills and lessons; CJK bigram tokenisation; recall and MRR evaluation.',
    sourcePath: '/skills/skill-search',
  },
  {
    id: 'skill:awr-ops',
    kind: 'skill',
    name: 'awr-ops',
    text: 'awr-ops\nDeploy to the Thor board, flash firmware images, lock-precision localisation, eHMI quality check.',
    sourcePath: '/skills/awr-ops',
  },
  {
    id: 'skill:data-ingest',
    kind: 'skill',
    name: 'data-ingest',
    text: 'data-ingest\n物料入库：扫描一次入库一行，解析天海批次，生成它石批次。',
    sourcePath: '/skills/data-ingest',
  },
  {
    id: 'skill:robot-calib',
    kind: 'skill',
    name: 'robot-calib',
    text: 'robot-calib\n标定与质检串行执行，禁止循环批量下发指令。',
    sourcePath: '/skills/robot-calib',
  },
  {
    id: 'lesson:l1',
    kind: 'lesson',
    name: 'an integration suite hangs on a free port',
    text: 'an integration suite hangs on a free port\nRetry with a port chosen by the OS rather than a fixed one.',
    sourcePath: '',
  },
  {
    id: 'lesson:l2',
    kind: 'lesson',
    name: 'when a rebase drops a commit',
    text: 'when a rebase drops a commit\nCheck git reflog before aborting.',
    sourcePath: '',
  },
]

/** query -> the ids that actually answer it. Fixed, not tuned. */
const HOLDOUT: Array<{ query: string; relevant: string[] }> = [
  { query: 'strip em-dash flourishes from prose', relevant: ['skill:humanizer'] },
  { query: 'how do I rank skills by relevance', relevant: ['skill:skill-search'] },
  { query: 'pdf', relevant: ['skill:pdf'] },
  { query: '物料入库扫描', relevant: ['skill:data-ingest'] },
  { query: 'flash firmware to the thor board', relevant: ['skill:awr-ops'] },
  { query: 'docx', relevant: ['skill:docx'] },
]

const K = 5

function recallAtK(retrieved: string[], relevant: string[]): number {
  const hit = relevant.some(id => retrieved.includes(id))
  return hit ? 1 : 0
}

function reciprocalRank(retrieved: string[], relevant: string[]): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.includes(retrieved[i]!)) return 1 / (i + 1)
  }
  return 0
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

describe('BM25 skill retrieval, measured against the name-substring baseline', () => {
  const index = buildSkillIndex(CORPUS)
  const baselineDocs = CORPUS.map(d => ({ id: d.id, name: d.name }))

  test('the baseline is a real competitor, not a straw man', () => {
    // If the baseline found nothing anywhere, "BM25 beats it" would be vacuous.
    // It genuinely wins the two queries that name their target.
    const baselineRecall = mean(
      HOLDOUT.map(({ query, relevant }) =>
        recallAtK(
          substringNameSearch(baselineDocs, query, K).map(h => h.id),
          relevant,
        ),
      ),
    )
    expect(baselineRecall).toBeGreaterThan(0)
  })

  test('BM25 Recall@5 >= baseline AND MRR strictly greater', () => {
    const bm25Recall: number[] = []
    const baseRecall: number[] = []
    const bm25Rr: number[] = []
    const baseRr: number[] = []

    for (const { query, relevant } of HOLDOUT) {
      const bm25Ids = searchDocs(index, CORPUS, query, K).map(h => h.doc.id)
      const baseIds = substringNameSearch(baselineDocs, query, K).map(h => h.id)

      bm25Recall.push(recallAtK(bm25Ids, relevant))
      baseRecall.push(recallAtK(baseIds, relevant))
      bm25Rr.push(reciprocalRank(bm25Ids, relevant))
      baseRr.push(reciprocalRank(baseIds, relevant))
    }

    const bm25RecallMean = mean(bm25Recall)
    const baseRecallMean = mean(baseRecall)
    const bm25Mrr = mean(bm25Rr)
    const baseMrr = mean(baseRr)

    // Printed so a failure shows the actual numbers rather than just false.
    console.log(
      `BM25  Recall@${K}=${bm25RecallMean.toFixed(3)} MRR=${bm25Mrr.toFixed(3)} | ` +
        `baseline Recall@${K}=${baseRecallMean.toFixed(3)} MRR=${baseMrr.toFixed(3)}`,
    )

    expect(bm25RecallMean).toBeGreaterThanOrEqual(baseRecallMean)
    expect(bm25Mrr).toBeGreaterThan(baseMrr)
  })

  test('cross-language and description-only queries are reachable', () => {
    // Each of these has no query term in the target's name, which is the case
    // the feature exists for.
    const cases: Array<[string, string]> = [
      ['strip em-dash flourishes from prose', 'skill:humanizer'],
      ['how do I rank skills by relevance', 'skill:skill-search'],
      ['物料入库扫描', 'skill:data-ingest'],
      ['flash firmware to the thor board', 'skill:awr-ops'],
    ]
    for (const [query, expected] of cases) {
      const top = searchDocs(index, CORPUS, query, K).map(h => h.doc.id)
      expect(top).toContain(expected)
    }
  })
})

describe('archived documents never surface', () => {
  test('a skill living under an archive/ segment is dropped from the corpus', () => {
    const archived = {
      type: 'prompt',
      name: 'retired-skill',
      description: 'A skill that was withdrawn.',
      skillRoot: '/home/u/.claude/skills/archive/retired-skill',
      isHidden: false,
    } as unknown as Command
    const live = {
      type: 'prompt',
      name: 'live-skill',
      description: 'A skill that is current.',
      skillRoot: '/home/u/.claude/skills/live-skill',
      isHidden: false,
    } as unknown as Command
    // `archive-tools` contains the substring but not the whole segment: it must
    // survive the filter.
    const tricky = {
      type: 'prompt',
      name: 'archive-tools',
      description: 'A live toolbox whose name merely starts with archive.',
      skillRoot: '/home/u/.claude/skills/archive-tools',
      isHidden: false,
    } as unknown as Command

    const docs = buildSkillDocs([archived, live, tricky], [] as Lesson[])
    const ids = docs.map(d => d.id)
    expect(ids).not.toContain('skill:retired-skill')
    expect(ids).toContain('skill:live-skill')
    expect(ids).toContain('skill:archive-tools')
  })

  test('isArchivedPath matches only a whole archive segment', () => {
    expect(isArchivedPath('/a/b/archive/c')).toBe(true)
    expect(isArchivedPath('/a/b/archive')).toBe(true)
    expect(isArchivedPath('/a/b/archive-tools/c')).toBe(false)
    expect(isArchivedPath('/a/b/archived/c')).toBe(false)
    expect(isArchivedPath('')).toBe(false)
    expect(isArchivedPath(undefined)).toBe(false)
  })
})

/**
 * The library walk. The loader only reads `<root>/<name>/SKILL.md`, so anything
 * a repository keeps in a plain `skills/` directory — or one level deeper, as
 * `ebook/book-architect/SKILL.md` is — is absent from the listing and must be
 * reached by the index instead. These tests run against a real temporary tree
 * rather than a mocked `readdir`, because the interesting behaviour is exactly
 * the filesystem contract: which directories the walk descends into, and which
 * it stops at.
 */
describe('skills under a plain skills/ root are indexed', () => {
  let root: string

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function skill(
    dir: string,
    scope: string,
    frontmatter: string,
  ): Promise<void> {
    await mkdir(join(dir, scope), { recursive: true })
    await writeFile(
      join(dir, scope, 'SKILL.md'),
      `---\n${frontmatter}\n---\n\nBody.\n`,
      'utf-8',
    )
  }

  test('the two roots are <cwd>/skills and ~/.claude/skills', () => {
    expect(extraSkillRoots('/work/repo')).toEqual([
      '/work/repo/skills',
      join(homedir(), '.claude', 'skills'),
    ])
  })

  test('depth-1 and nested skills are found; hidden dirs and archive/ are not', async () => {
    root = await mkdtemp(join(tmpdir(), 'skillwalk-'))
    await skill(root, 'flat-skill', 'name: flat\nwhen_to_use: when flat applies')
    // Nested one level down, through a directory that is not itself a skill —
    // the `ebook/book-architect` shape.
    await skill(root, 'group/nested-skill', 'name: nested')
    // A skill directory must not be descended into: its own subdirectories are
    // assets, and a stray SKILL.md under one is not a second skill.
    await skill(root, 'flat-skill/assets', 'name: not-a-skill')
    // Hidden directory holding a SKILL.md: not part of the library.
    await skill(root, '.git/hidden-skill', 'name: hidden')
    // Retired skill under a whole `archive` segment.
    await skill(root, 'archive/retired-skill', 'name: retired')

    const ids = (await loadSkillDocsFromRoot(root)).map(d => d.id).sort()
    expect(ids).toEqual(['skill:flat-skill', 'skill:nested-skill'])
  })

  test('frontmatter name/description/when_to_use become the searchable text', async () => {
    root = await mkdtemp(join(tmpdir(), 'skillwalk-'))
    await skill(
      root,
      'thor-flash',
      'name: thor-flash\ndescription: Flash firmware images onto the Thor board.\nwhen_to_use: When a board is bricked.',
    )
    const [doc] = await loadSkillDocsFromRoot(root)
    expect(doc!.name).toBe('thor-flash')
    expect(doc!.text).toContain('Flash firmware images onto the Thor board.')
    expect(doc!.text).toContain('When a board is bricked.')
    expect(doc!.sourcePath).toBe(join(root, 'thor-flash'))
  })

  test('a missing root is empty, not an error', async () => {
    expect(await loadSkillDocsFromRoot('/nonexistent/root/xyz')).toEqual([])
  })

  test('mergeSkillDocs keeps the command copy and drops the duplicate', () => {
    const fromCommand: SkillDoc[] = [
      {
        id: 'skill:pdf',
        kind: 'skill',
        name: 'pdf',
        text: 'pdf\nlisted',
        sourcePath: '/cfg/skills/pdf',
      },
    ]
    const fromWalk: SkillDoc[] = [
      { id: 'skill:pdf', kind: 'skill', name: 'pdf', text: 'pdf\nwalked', sourcePath: '/repo/skills/pdf' },
      { id: 'skill:PDF', kind: 'skill', name: 'PDF', text: 'PDF\nother', sourcePath: '/repo/skills/PDF' },
      { id: 'skill:newone', kind: 'skill', name: 'newone', text: 'newone\nbody', sourcePath: '/repo/skills/newone' },
    ]
    const merged = mergeSkillDocs(fromCommand, fromWalk)
    expect(merged.map(d => d.id)).toEqual(['skill:pdf', 'skill:newone'])
    // The surviving copy is the invocable one, not the walked one.
    expect(merged[0]!.sourcePath).toBe('/cfg/skills/pdf')
  })

  test('a skill from a plain root is retrievable end to end', async () => {
    root = await mkdtemp(join(tmpdir(), 'skillwalk-'))
    await skill(
      root,
      'harmonyos-ui-automator',
      'name: harmonyos-ui-automator\ndescription: Drive HarmonyOS app UI through automated taps and assertions.',
    )
    const docs = mergeSkillDocs(buildSkillDocs([], [] as Lesson[]), await loadSkillDocsFromRoot(root))
    const index = buildSkillIndex(docs)
    const top = searchDocs(index, docs, 'automate harmonyos app ui taps', 5).map(
      h => h.doc.id,
    )
    expect(top).toContain('skill:harmonyos-ui-automator')
  })
})
