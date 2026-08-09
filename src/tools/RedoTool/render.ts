/**
 * Render the chronicle.
 *
 * Structure follows the reference skill's template — conclusion first, then
 * the panorama, the character table, one chapter per year, the epilogue, the
 * community track, appendices, and a methodology note. Two of those sections
 * exist specifically to keep the document honest:
 *
 *   - the community track runs parallel to the git narrative and is
 *     joined to it only at 互文时刻, so a claim that the community drove a
 *     change is always shown as two dated records rather than asserted in
 *     prose;
 *   - the methodology note carries the fetch limits, the identity merges and
 *     the self-check findings. Every inference this pipeline makes has to be
 *     visible there, because an undisclosed inference in a document that
 *     advertises traceability is worse than no document.
 *
 * Everything here is deterministic string assembly over facts computed
 * elsewhere; the only model-written material is what `narrate.ts` returned.
 */

import {
  asciiBarChart,
  silentYears,
  type AuthorStat,
  type Commit,
  type IdentityMerge,
  type Panorama,
  type YearStat,
} from './git.js'
import type { GhIssue, GhRelease, IntertextualMoment } from './github.js'
import type { NarratedChapter } from './narrate.js'
import type { YearEvidence } from './evidence.js'

export type ChapterOutput = {
  evidence: YearEvidence
  narrated: NarratedChapter
}

export type ChronicleInput = {
  repoName: string
  repoUrl: string
  generatedAt: string
  commits: Commit[]
  panorama: Panorama
  yearStats: YearStat[]
  authors: AuthorStat[]
  identityMerges: IdentityMerge[]
  releases: GhRelease[]
  issues: GhIssue[]
  moments: IntertextualMoment[]
  chapters: ChapterOutput[]
  /** Model-written closing lessons; empty when generation failed. */
  epilogue: string[]
  githubAvailable: boolean
  githubNote?: string
  /** Rendered self-check, appended to the methodology note. */
  verification: string
  /** Anything the run could not do, surfaced rather than dropped. */
  gaps: string[]
}

function h(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`
}

/**
 * One commit, in the reference's fixed line format:
 *   `hash` **#PR 标题**（作者）说明
 * The hash is the line's own citation, so traceability does not depend on the
 * model remembering to cite.
 */
function commitLine(c: Commit): string {
  const pr = c.pr !== null ? `**#${c.pr} ${c.subject}**` : `**${c.subject}**`
  return `\`${c.shortHash}\` ${pr}（${c.author}，${c.date}）`
}

function renderParagraphs(chapter: NarratedChapter): string {
  if (!chapter.ok || chapter.paragraphs.length === 0) {
    return `> 本章未能生成叙述：${chapter.error ?? '原因未记录'}。以下仅保留可核对的提交记录。`
  }
  return chapter.paragraphs
    .map(p => {
      const cites = p.cites.length > 0 ? `　［${p.cites.join('，')}］` : ''
      // Speculation is rendered as a marked block, never inline with fact.
      return p.speculative
        ? `> **［推断，未证实］** ${p.text}${cites}`
        : `${p.text}${cites}`
    })
    .join('\n\n')
}

function renderPanorama(input: ChronicleInput): string {
  const rows: [string, string][] = [
    ['生命周期', input.panorama.lifespan],
    ['提交总数', String(input.panorama.totalCommits)],
    ['其中合并提交', String(input.panorama.mergeCommits)],
    ['作者数', String(input.panorama.totalAuthors)],
    ['PR 数', input.panorama.prCount > 0 ? `${input.panorama.prCount}（${input.panorama.prRange}）` : '0'],
    ['release 数', String(input.releases.length)],
    ['issue / PR 抓取数', input.githubAvailable ? String(input.issues.length) : '未抓取'],
  ]
  return [
    '| 指标 | 数值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join('\n')
}

function renderAuthors(authors: readonly AuthorStat[]): string {
  return [
    '| 作者 | 提交数 | 活跃期 | 角色定位 |',
    '|---|---|---|---|',
    ...authors.map(a => {
      const founder = a.isFounder ? '创始人，' : ''
      return `| ${a.name} | ${a.commits} | ${a.activePeriod} | ${founder}${a.role} |`
    }),
  ].join('\n')
}

/**
 * Yearly heat comparison: commits against community volume.
 *
 * Printed side by side because the interesting years are the ones where the
 * two columns disagree — a year of heavy discussion and no code, or code
 * landing in silence.
 */
function renderHeatTable(input: ChronicleInput): string {
  const issuesByYear = new Map<string, number>()
  for (const i of input.issues) {
    const y = i.createdAt.slice(0, 4)
    if (y) issuesByYear.set(y, (issuesByYear.get(y) ?? 0) + 1)
  }
  return [
    '| 年份 | 新增 issue/PR | git 提交 | 参与者 |',
    '|---|---|---|---|',
    ...input.yearStats.map(s => {
      const issues = input.githubAvailable ? String(issuesByYear.get(s.year) ?? 0) : '—'
      return `| ${s.year} | ${issues} | ${s.commits} | ${s.authors} |`
    }),
  ].join('\n')
}

function renderMoments(moments: readonly IntertextualMoment[]): string {
  if (moments.length === 0) {
    return '未在提交记录中找到「先有讨论、后有提交」的可核对配对。'
  }
  return moments
    .map(
      m =>
        `- **#${m.issue.number}「${m.issue.title}」**（${m.issue.createdAt} 提出，${m.issue.comments} 条评论）` +
        `　→　\`${m.commitShortHash}\` ${m.commitSubject}（${m.commitDate}，${m.latencyDays} 天后落地）`,
    )
    .join('\n')
}

function renderPrTimeline(commits: readonly Commit[]): string {
  const byYear = new Map<string, string[]>()
  for (const c of commits) {
    if (c.pr === null) continue
    const y = c.date.slice(0, 4)
    byYear.set(y, [...(byYear.get(y) ?? []), `#${c.pr} ${c.subject}`])
  }
  if (byYear.size === 0) return '本仓库的提交消息中未提取到 PR 编号。'
  return [...byYear.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, items]) => `**${year}**\n${items.map(i => `- ${i}`).join('\n')}`)
    .join('\n\n')
}

function renderMethodology(input: ChronicleInput): string {
  const lines: string[] = [
    `- 提交口径：\`git log\` 全部提交，含合并提交（共 ${input.panorama.mergeCommits} 条）；年份以提交日期为准。`,
    '- PR 编号提取规则：优先 `Merge pull request #N`，其次行尾 `(#N)`，最后消息中首个 `#N`；五位以上数字视为非 PR 编号丢弃。',
  ]

  if (input.identityMerges.length > 0) {
    lines.push(
      `- 身份归并（推断，共 ${input.identityMerges.length} 组）：同一人使用多个署名或邮箱时已合并计数，依据如下。`,
    )
    for (const m of input.identityMerges) {
      lines.push(
        `  - ${m.canonical} ← ${m.aliases.map(a => `${a.name} <${a.email}> ${a.commits} 条`).join('；')}（依据：${m.basis}）`,
      )
    }
  } else {
    lines.push('- 身份归并：未发现需要合并的重复署名。')
  }

  if (input.githubAvailable) {
    lines.push(`- GitHub 数据：release ${input.releases.length} 个、issue/PR ${input.issues.length} 条。`)
    if (input.githubNote) lines.push(`  - 覆盖率说明：${input.githubNote}`)
  } else {
    lines.push(`- GitHub 数据：未获取。${input.githubNote ?? ''}`)
    lines.push('  - 因此本文没有社区线证据，社区回声一节与互文时刻均为空，相关判断不应被视为已核对。')
  }

  const speculative = input.chapters.reduce(
    (s, c) => s + c.narrated.paragraphs.filter(p => p.speculative).length,
    0,
  )
  const total = input.chapters.reduce((s, c) => s + c.narrated.paragraphs.length, 0)
  lines.push(
    `- 推断标注：全文 ${total} 个叙述段落中有 ${speculative} 段标为「推断，未证实」，均以引用块单独呈现。`,
  )

  const dropped = input.chapters.reduce((s, c) => s + c.narrated.dropped.length, 0)
  if (dropped > 0) {
    lines.push(`- 已丢弃 ${dropped} 个缺少可解析引用的段落（无来源即不入正文）。`)
  }

  const warnings = input.chapters.flatMap(c =>
    c.narrated.warnings.map(w => `${c.evidence.year} 年：${w}`),
  )
  for (const w of warnings) lines.push(`- ${w}`)

  const sampledYears = input.chapters.filter(c => c.evidence.sampled)
  if (sampledYears.length > 0) {
    lines.push(
      `- 抽样口径：${sampledYears.map(c => `${c.evidence.year} 年（${c.evidence.totalCommits} → ${c.evidence.commits.length} 条）`).join('、')}；未列出的提交不在引用范围内。`,
    )
  }

  for (const gap of input.gaps) lines.push(`- ${gap}`)
  lines.push(input.verification)

  return lines.join('\n')
}

export function renderChronicle(input: ChronicleInput): string {
  const out: string[] = []
  const silent = silentYears(input.yearStats)

  // ── 题头：结论先行 ─────────────────────────────────────────────
  out.push(h(1, `《${input.repoName} 开发编年史：从 0 到 1》`))
  out.push(
    [
      `> 仓库　${input.repoUrl}`,
      `> 整理日期　${input.generatedAt}`,
      `> 数据来源　${input.panorama.totalCommits} 条 git 提交逐一核对` +
        (input.githubAvailable
          ? `、${input.releases.length} 个 release、${input.issues.length} 条 issue/PR`
          : '（无 GitHub 数据）'),
    ].join('\n'),
  )

  // ── §0 项目是什么 ──────────────────────────────────────────────
  out.push(h(2, '§0　全景'))
  out.push(renderPanorama(input))
  out.push(h(3, '年度提交量'))
  out.push('```\n' + asciiBarChart(input.yearStats) + '\n```')
  if (silent.length > 0) {
    out.push(`沉寂年份：${silent.join('、')}——这些年份没有任何提交。`)
  }

  // ── §1 人物图鉴 ────────────────────────────────────────────────
  out.push(h(2, '§1　人物图鉴'))
  out.push(renderAuthors(input.authors))

  // ── 编年史主体 ─────────────────────────────────────────────────
  input.chapters.forEach((ch, i) => {
    const { evidence: ev, narrated } = ch
    out.push(h(2, `§${i + 2}　${ev.year} 年：${narrated.title}`))
    out.push(
      `> 本年 ${ev.stat.commits} 条提交，${ev.stat.authors} 位参与者` +
        (ev.releases.length > 0 ? `，发布 ${ev.releases.map(r => r.tag).join('、')}` : '') +
        '。',
    )
    out.push(renderParagraphs(narrated))

    if (ev.moments.length > 0) {
      out.push(h(3, '本年互文时刻'))
      out.push(renderMoments(ev.moments))
    }

    out.push(h(3, `本年提交${ev.sampled ? `（抽样 ${ev.commits.length} / ${ev.totalCommits} 条）` : ''}`))
    out.push(ev.commits.map(commitLine).join('\n'))
  })

  // Section numbers follow the year chapters rather than being fixed at
  // §10/§11 as in the reference template, which assumes about eight of them.
  // Fifteen years pushed the last chapter onto §11 and collided with the
  // community track.
  const epilogueNo = input.chapters.length + 2
  const communityNo = epilogueNo + 1

  // ── 尾声 ───────────────────────────────────────────────────────
  out.push(h(2, `§${epilogueNo}　尾声`))
  out.push(
    input.epilogue.length > 0
      ? input.epilogue.map(l => `- ${l}`).join('\n')
      : '_未能生成结语。_',
  )

  // ── 社区回声（此处为 issue/PR 社区线）─────────────────────────
  out.push(h(2, `§${communityNo}　社区回声`))
  if (!input.githubAvailable) {
    out.push('未获取 GitHub 数据，本节为空。项目的社区史因此没有进入本文，不应据本文判断社区的作用。')
  } else {
    out.push(h(3, '热度对照'))
    out.push(renderHeatTable(input))
    out.push(h(3, '互文时刻：讨论如何变成代码'))
    out.push(renderMoments(input.moments))
  }

  // ── 附录 ───────────────────────────────────────────────────────
  out.push(h(2, '附录 A　PR 时间线'))
  out.push(renderPrTimeline(input.commits))

  if (input.githubAvailable && input.issues.length > 0) {
    out.push(h(2, '附录 B　讨论最多的 issue'))
    const top = [...input.issues]
      .filter(i => !i.isPr && i.comments > 0)
      .sort((a, b) => b.comments - a.comments)
      .slice(0, 20)
    out.push(
      [
        '| # | 标题 | 评论数 | 提出时间 | 状态 |',
        '|---|---|---|---|---|',
        ...top.map(
          i =>
            `| #${i.number} | ${i.title.replace(/\|/g, '\\|')} | ${i.comments} | ${i.createdAt} | ${i.state === 'closed' ? '已关闭' : '开放'} |`,
        ),
      ].join('\n'),
    )
  }

  // ── 方法论注记 ─────────────────────────────────────────────────
  out.push(h(2, '数据方法论注记'))
  out.push(renderMethodology(input))

  return out.join('\n\n') + '\n'
}
