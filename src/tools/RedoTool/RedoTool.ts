import { access, mkdir, readFile, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { dirname, join, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, REDO_TOOL_NAME } from './prompt.js'
import {
  groupByYear,
  LOG_FORMAT,
  panorama,
  parseCommitLog,
  perAuthor,
  perYear,
  resolveIdentities,
  type Commit,
} from './git.js'
import { segmentEras, type BoundarySignal, type Tag } from './eras.js'
import {
  EMPTY_GH_DATA,
  fetchGitHubData,
  findIntertextualMoments,
  type GhData,
} from './github.js'
import { buildYearEvidence, citeIndexFor, renderLedger } from './evidence.js'
import { narrateChapter, narrateEpilogue } from './narrate.js'
import { renderChronicle, type ChapterOutput } from './render.js'
import { renderVerification, verifyChronicle, type VerificationFacts } from './verify.js'

const inputSchema = lazySchema(() =>
  z.object({
    repoUrl: z
      .string()
      .describe('Git repository URL, e.g. https://github.com/tj/n. Used for cloning and for the GitHub API.'),
    localRepoPath: z
      .string()
      .optional()
      .describe('Existing local clone. When given, no clone is performed.'),
    outputPath: z
      .string()
      .optional()
      .describe('Where to write the chronicle. Default: <cwd>/<repo>-编年史.md'),
    startYear: z.number().int().optional().describe('First year to cover; earlier years are summarised in the panorama only'),
    endYear: z.number().int().optional().describe('Last year to cover'),
    maxIssues: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .default(500)
      .describe('Upper bound on issues/PRs fetched, oldest first'),
    skipGitHub: z
      .boolean()
      .default(false)
      .describe('Skip the GitHub API entirely and write a git-only chronicle'),
    resume: z
      .boolean()
      .default(true)
      .describe('Reuse chapters already written into the checkpoint file'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    repoName: z.string(),
    outputPath: z.string(),
    totalCommits: z.number().int(),
    years: z.number().int(),
    chaptersWritten: z.number().int(),
    chaptersFailed: z.number().int(),
    githubAvailable: z.boolean(),
    verificationOk: z.boolean(),
    findings: z.array(z.string()),
    message: z.string(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// ── helpers ───────────────────────────────────────────────────────────

function repoNameFromUrl(repoUrl: string): string {
  const clean = repoUrl.replace(/\.git$/i, '').replace(/\/$/, '')
  const seg = clean.split('/').filter(Boolean).pop()
  return seg ? seg.replace(/[^a-zA-Z0-9._-]/g, '_') : 'repo'
}

/** `owner/repo`, or null when the URL is not a GitHub one. */
export function ownerRepoFromUrl(repoUrl: string): string | null {
  const m = repoUrl
    .replace(/\.git$/i, '')
    .match(/github\.com[:/]([^/]+)\/([^/]+)\/?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runCommand(
  command: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const proc = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', signal })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(stderr.trim() || `command failed: ${command.join(' ')}`)
  }
  return stdout
}

/** Annotated and lightweight tags alike, with the date git records for each. */
async function readTags(repoPath: string, signal: AbortSignal): Promise<Tag[]> {
  try {
    const out = await runCommand(
      ['git', 'tag', '-l', '--sort=creatordate', '--format=%(refname:short)\t%(creatordate:short)'],
      repoPath,
      signal,
    )
    return out
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [name, date] = l.split('\t')
        return { name: name ?? '', date: date ?? '' }
      })
      .filter(t => t.name && t.date)
  } catch {
    return []
  }
}

type Checkpoint = {
  repoUrl: string
  chapters: Record<
    string,
    { title: string; paragraphs: unknown[]; storyState: string; warnings: string[]; dropped: string[] }
  >
}

async function readCheckpoint(path: string): Promise<Checkpoint | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Checkpoint
  } catch {
    return null
  }
}

// ── tool ──────────────────────────────────────────────────────────────

export const RedoTool = buildTool({
  name: REDO_TOOL_NAME,
  searchHint: 'write a project chronicle from git history, releases and issue discussions',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'RedoTool'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `chronicle ${input.repoUrl}`
  },
  async call(input: Input, context) {
    const signal = context.abortController.signal
    const repoName = repoNameFromUrl(input.repoUrl)
    const gaps: string[] = []

    // ── 1. repository ────────────────────────────────────────────────
    let repoPath = input.localRepoPath ? resolve(input.localRepoPath) : ''
    if (!repoPath) {
      repoPath = join(process.cwd(), repoName)
      if (!(await exists(repoPath))) {
        await runCommand(['git', 'clone', '--quiet', input.repoUrl, repoPath], process.cwd(), signal)
      }
    }
    if (!(await exists(repoPath))) {
      throw new Error(`repository not found: ${repoPath}`)
    }

    const outputPath = resolve(
      input.outputPath ?? join(process.cwd(), `${repoName}-编年史.md`),
    )
    const checkpointPath = join(dirname(outputPath), `.${repoName}-chronicle-state.json`)

    // ── 2. git facts ─────────────────────────────────────────────────
    const commits = parseCommitLog(
      await runCommand(
        ['git', 'log', '--reverse', `--format=${LOG_FORMAT}`, '--date=short'],
        repoPath,
        signal,
      ),
    )
    if (commits.length === 0) {
      throw new Error('no commits found in the repository')
    }

    const tags = await readTags(repoPath, signal)
    const stats = perYear(commits)
    const authors = perAuthor(commits)
    const { merges } = resolveIdentities(commits)
    const pan = panorama(commits)

    // Era signals are used as the per-year "significant events" list rather
    // than as chapter boundaries: a chronicle is chaptered by year.
    const { signals } = segmentEras({ commits, tags })
    const eventsByYear = new Map<string, BoundarySignal[]>()
    for (const s of signals) {
      const year = commits[s.index]?.date.slice(0, 4)
      if (!year) continue
      eventsByYear.set(year, [...(eventsByYear.get(year) ?? []), s])
    }

    // ── 3. GitHub ────────────────────────────────────────────────────
    let gh: GhData = EMPTY_GH_DATA
    const ownerRepo = ownerRepoFromUrl(input.repoUrl)
    if (input.skipGitHub) {
      gh = { ...EMPTY_GH_DATA, reason: '按参数要求跳过 GitHub 数据' }
    } else if (!ownerRepo) {
      gh = { ...EMPTY_GH_DATA, reason: `${input.repoUrl} 不是 GitHub 仓库地址，无法获取 issue 与 release` }
    } else {
      gh = await fetchGitHubData({ repo: ownerRepo, signal, maxIssues: input.maxIssues })
    }
    if (!gh.available && gh.reason) gaps.push(gh.reason)

    const moments = findIntertextualMoments(gh.issues, commits, 40)

    // ── 4. chapters, one per year ────────────────────────────────────
    const byYear = groupByYear(commits)
    const years = [...byYear.keys()].filter(y => {
      const n = Number.parseInt(y, 10)
      if (input.startYear !== undefined && n < input.startYear) return false
      if (input.endYear !== undefined && n > input.endYear) return false
      return true
    })
    if (years.length < byYear.size) {
      gaps.push(
        `按参数只覆盖 ${years[0]} 到 ${years[years.length - 1]} 年；全库实际跨越 ${[...byYear.keys()][0]} 到 ${[...byYear.keys()].pop()} 年。`,
      )
    }

    const checkpoint = input.resume ? await readCheckpoint(checkpointPath) : null
    const reusable =
      checkpoint && checkpoint.repoUrl === input.repoUrl ? checkpoint.chapters : {}

    const chapters: ChapterOutput[] = []
    const storyStates: string[] = []
    let previousState = ''
    let failed = 0

    for (const year of years) {
      const evidence = buildYearEvidence({
        year,
        commits: byYear.get(year) ?? [],
        stat: stats.find(s => s.year === year) ?? { year, commits: 0, authors: 0 },
        releases: gh.releases,
        issues: gh.issues,
        moments,
        events: eventsByYear.get(year) ?? [],
      })

      const cached = reusable[year]
      if (cached) {
        const narrated = {
          ok: true,
          title: cached.title,
          paragraphs: cached.paragraphs as ChapterOutput['narrated']['paragraphs'],
          storyState: cached.storyState,
          warnings: cached.warnings ?? [],
          dropped: cached.dropped ?? [],
        }
        chapters.push({ evidence, narrated })
        previousState = cached.storyState
        storyStates.push(cached.storyState)
        continue
      }

      const narrated = await narrateChapter({
        repoName,
        eraOrdinal: chapters.length + 1,
        ledger: renderLedger(evidence),
        previousState,
        index: citeIndexFor(evidence),
        signal,
      })
      if (!narrated.ok) failed++
      chapters.push({ evidence, narrated })
      previousState = narrated.storyState
      storyStates.push(narrated.storyState)

      // Checkpoint after every chapter: a fifteen-year history is a long,
      // paid-for run, and a failure at year fourteen used to discard the
      // thirteen chapters already written.
      reusable[year] = {
        title: narrated.title,
        paragraphs: narrated.paragraphs,
        storyState: narrated.storyState,
        warnings: narrated.warnings,
        dropped: narrated.dropped,
      }
      await mkdir(dirname(checkpointPath), { recursive: true })
      await writeFile(
        checkpointPath,
        JSON.stringify({ repoUrl: input.repoUrl, chapters: reusable }, null, 1),
        'utf-8',
      )
    }

    // ── 5. epilogue, render, verify ──────────────────────────────────
    const epilogue = await narrateEpilogue({
      repoName,
      storyStates: storyStates.filter(Boolean),
      panoramaSummary: `${pan.lifespan}，${pan.totalCommits} 条提交，${pan.totalAuthors} 位作者。`,
      signal,
    })

    const facts: VerificationFacts = {
      commits: new Map(
        commits.map(c => [
          c.shortHash.toLowerCase(),
          { author: c.author, date: c.date, subject: c.subject },
        ]),
      ),
      // Numbers attested by git itself count as known: a `#N` rendered from a
      // commit subject is not a fabrication just because the issue fetch
      // stopped short of it.
      issues: new Set([
        ...gh.issues.map(i => i.number),
        ...commits.flatMap(c => c.refs),
      ]),
      releases: new Set(gh.releases.map(r => r.tag.toLowerCase())),
      yearStats: stats,
      panorama: pan,
      githubAvailable: gh.available,
    }

    // Rendered twice on purpose: the self-check reads the finished document,
    // and its findings belong inside that document's methodology note.
    const draft = renderChronicle({
      repoName,
      repoUrl: input.repoUrl,
      generatedAt: new Date().toISOString().slice(0, 10),
      commits,
      panorama: pan,
      yearStats: stats,
      authors,
      identityMerges: merges,
      releases: gh.releases,
      issues: gh.issues,
      moments,
      chapters,
      epilogue,
      githubAvailable: gh.available,
      githubNote: gh.reason,
      verification: '',
      gaps,
    })
    const report = verifyChronicle(draft, facts)
    const final = renderChronicle({
      repoName,
      repoUrl: input.repoUrl,
      generatedAt: new Date().toISOString().slice(0, 10),
      commits,
      panorama: pan,
      yearStats: stats,
      authors,
      identityMerges: merges,
      releases: gh.releases,
      issues: gh.issues,
      moments,
      chapters,
      epilogue,
      githubAvailable: gh.available,
      githubNote: gh.reason,
      verification: renderVerification(report),
      gaps,
    })

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, final, 'utf-8')

    return {
      data: {
        success: true,
        repoName,
        outputPath,
        totalCommits: commits.length,
        years: years.length,
        chaptersWritten: chapters.length - failed,
        chaptersFailed: failed,
        githubAvailable: gh.available,
        verificationOk: report.ok,
        findings: report.findings.map(f => `[${f.severity}] ${f.detail}`),
        message: `已写出 ${chapters.length} 章编年史到 ${outputPath}`,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const d = content as Output
    const lines = [
      d.success ? `编年史已生成：${d.outputPath}` : `生成失败：${d.message}`,
      `仓库 ${d.repoName}｜提交 ${d.totalCommits} 条｜${d.years} 个年份章节`,
      `GitHub 数据：${d.githubAvailable ? '已获取' : '未获取（仅 git 线）'}`,
      d.chaptersFailed > 0 ? `其中 ${d.chaptersFailed} 章因证据不足未能生成叙述` : null,
      `自动校验：${d.verificationOk ? '通过' : '发现问题'}`,
      ...d.findings.slice(0, 10).map(f => `  ${f}`),
      d.findings.length > 10 ? `  …另有 ${d.findings.length - 10} 项` : null,
    ].filter(Boolean)
    return { tool_use_id: toolUseID, type: 'tool_result', content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
