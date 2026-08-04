import {
  analyzeChapter,
  analyzeVoices,
  formatSenseList,
  type ChapterAnalysis,
  type VoiceAnalysis,
} from './analyze.js'

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface ManuscriptCheck {
  id: string
  title: string
  status: CheckStatus
  detail: string
}

export type ManuscriptVerdict = 'clean' | 'needs_revision' | 'incomplete'

export interface ChapterReport {
  verdict: ManuscriptVerdict
  reason: string
  checks: ManuscriptCheck[]
  analysis: ChapterAnalysis
  file: string
}

export interface ChapterThresholds {
  /** Minimum share of the chapter that is dialogue. */
  minDialogueRatio: number
  /** Minimum non-visual senses that must appear. */
  minNonVisualSenses: number
  /** Chapter length bounds, when the caller states them. */
  minCharacters?: number
  maxCharacters?: number
}

export const DEFAULT_THRESHOLDS: ChapterThresholds = {
  minDialogueRatio: 0.2,
  minNonVisualSenses: 2,
}

function checkAiTells(analysis: ChapterAnalysis): ManuscriptCheck {
  const high = analysis.tells.filter(t => t.severity === 'high')
  const medium = analysis.tells.filter(t => t.severity === 'medium')

  if (analysis.tells.length === 0) {
    return {
      id: 'ai_tells',
      title: '去 AI 味清单',
      status: 'pass',
      detail: '未命中清单上的任何模板短语。',
    }
  }

  const render = (list: typeof analysis.tells) =>
    list
      .map(t => {
        const examples = t.examples
          .map(e => `        L${e.line}: …${e.text}…`)
          .join('\n')
        return `      ${t.id} ×${t.count} — ${t.why}\n        改法: ${t.fix}\n${examples}`
      })
      .join('\n')

  if (high.length > 0) {
    return {
      id: 'ai_tells',
      title: '去 AI 味清单',
      status: 'fail',
      detail: `命中 ${high.length} 类高置信 AI 痕迹${medium.length > 0 ? `，另有 ${medium.length} 类中等` : ''}:\n${render(high)}${
        medium.length > 0 ? `\n${render(medium)}` : ''
      }`,
    }
  }
  return {
    id: 'ai_tells',
    title: '去 AI 味清单',
    status: 'fail',
    detail: `命中 ${medium.length} 类中等 AI 痕迹:\n${render(medium)}`,
  }
}

function checkDialogueRatio(
  analysis: ChapterAnalysis,
  thresholds: ChapterThresholds,
): ManuscriptCheck {
  const pct = (analysis.dialogueRatio * 100).toFixed(1)
  const floor = (thresholds.minDialogueRatio * 100).toFixed(0)

  if (analysis.dialogueRatio < thresholds.minDialogueRatio) {
    return {
      id: 'dialogue_ratio',
      title: '对话占比',
      status: 'fail',
      detail: `对话占 ${pct}%，低于 ${floor}%。整章几乎都是叙述，读者听不到人物的声音。把关键的叙述段落改写成场景。`,
    }
  }
  return {
    id: 'dialogue_ratio',
    title: '对话占比',
    status: 'pass',
    detail: `对话占 ${pct}%（${analysis.dialogueLines} 处引语，识别出 ${analysis.speakers.length} 位说话人）。`,
  }
}

function checkSensory(
  analysis: ChapterAnalysis,
  thresholds: ChapterThresholds,
): ManuscriptCheck {
  const { sensory } = analysis
  const nonVisual = sensory.nonVisualPresent

  if (nonVisual.length < thresholds.minNonVisualSenses) {
    const missing = (['auditory', 'tactile', 'olfactory', 'gustatory'] as const)
      .filter(s => !nonVisual.includes(s))
      .slice(0, 3)
    return {
      id: 'sensory_coverage',
      title: '感官覆盖',
      status: 'fail',
      detail: `非视觉感官只有 ${nonVisual.length} 种（${formatSenseList(nonVisual) || '无'}），少于 ${thresholds.minNonVisualSenses} 种。缺少的可用: ${formatSenseList([...missing])}。只靠视觉写场景，读者是在看剧照而不是在场。`,
    }
  }
  return {
    id: 'sensory_coverage',
    title: '感官覆盖',
    status: 'pass',
    detail: `覆盖 ${formatSenseList(sensory.present)}（非视觉 ${nonVisual.length} 种）。`,
  }
}

function checkLength(
  analysis: ChapterAnalysis,
  thresholds: ChapterThresholds,
): ManuscriptCheck {
  const { minCharacters, maxCharacters } = thresholds
  if (minCharacters === undefined && maxCharacters === undefined) {
    return {
      id: 'length',
      title: '章节长度',
      status: 'skipped',
      detail: `${analysis.characters.toLocaleString()} 字。未给出区间，跳过判定。`,
    }
  }
  if (minCharacters !== undefined && analysis.characters < minCharacters) {
    return {
      id: 'length',
      title: '章节长度',
      status: 'fail',
      detail: `${analysis.characters.toLocaleString()} 字，低于下限 ${minCharacters.toLocaleString()}。`,
    }
  }
  if (maxCharacters !== undefined && analysis.characters > maxCharacters) {
    return {
      id: 'length',
      title: '章节长度',
      status: 'fail',
      detail: `${analysis.characters.toLocaleString()} 字，超过上限 ${maxCharacters.toLocaleString()}。`,
    }
  }
  return {
    id: 'length',
    title: '章节长度',
    status: 'pass',
    detail: `${analysis.characters.toLocaleString()} 字，在区间内。`,
  }
}

export function checkChapter(
  file: string,
  text: string,
  thresholds: ChapterThresholds = DEFAULT_THRESHOLDS,
): ChapterReport {
  const analysis = analyzeChapter(text)

  if (analysis.characters < 100) {
    return {
      verdict: 'incomplete',
      reason: `只有 ${analysis.characters} 字，不足以判定任何指标。`,
      checks: [
        {
          id: 'length',
          title: '章节长度',
          status: 'fail',
          detail: '正文太短，无法分析。',
        },
      ],
      analysis,
      file,
    }
  }

  const checks = [
    checkAiTells(analysis),
    checkDialogueRatio(analysis, thresholds),
    checkSensory(analysis, thresholds),
    checkLength(analysis, thresholds),
  ]

  const failed = checks.filter(c => c.status === 'fail')
  return {
    verdict: failed.length > 0 ? 'needs_revision' : 'clean',
    reason:
      failed.length > 0
        ? `${failed.length} 项需要修改: ${failed.map(c => c.id).join('、')}。`
        : '机器可查的项目全部通过。文学质量仍需你自己判断——这些检查只排除机械毛病，不证明写得好。',
    checks,
    analysis,
    file,
  }
}

// ── Manuscript-level ──────────────────────────────────────────────

export interface ForeshadowingItem {
  id: string
  description: string
  /** Chapter number where it was planted. */
  planted: number
  /** Chapter where it is meant to pay off, if planned. */
  plannedPayoff?: number | null
  /** Chapter where it actually paid off. */
  paidOff?: number | null
}

export interface ManuscriptReport {
  verdict: ManuscriptVerdict
  reason: string
  checks: ManuscriptCheck[]
  voices?: VoiceAnalysis
  chapterCount: number
}

/** Above this cosine similarity, two characters read as the same voice. */
const VOICE_SIMILARITY_CEILING = 0.86
/** Foreshadowing left hanging this many chapters is at risk of being forgotten. */
const FORESHADOWING_STALE_AFTER = 10

function checkVoices(voices: VoiceAnalysis): ManuscriptCheck {
  if (voices.profiles.length < 2) {
    return {
      id: 'character_voices',
      title: '对话可辨识度',
      status: 'skipped',
      detail: `只识别出 ${voices.profiles.length} 位有足量对话的角色，无法比较。${
        voices.underSampled.length > 0
          ? `对话过少: ${voices.underSampled.join('、')}。`
          : '检查署名格式是否为"角色名说：「……」"或"「……」角色名说"。'
      }`,
    }
  }

  const tooSimilar = voices.pairs.filter(
    p => p.similarity > VOICE_SIMILARITY_CEILING,
  )
  const profileLines = voices.profiles
    .map(
      p =>
        `      ${p.speaker}: ${p.lines} 句 / 均长 ${p.meanLineLength.toFixed(1)} 字 / 特征词 ${
          p.distinctive.length > 0 ? p.distinctive.join('、') : '无明显特征'
        }`,
    )
    .join('\n')

  if (tooSimilar.length > 0) {
    const list = tooSimilar
      .map(p => `      ${p.a} ↔ ${p.b}: 相似度 ${p.similarity.toFixed(3)}`)
      .join('\n')
    return {
      id: 'character_voices',
      title: '对话可辨识度',
      status: 'fail',
      detail: `${tooSimilar.length} 对角色的对话在用词分布上几乎无法区分（阈值 ${VOICE_SIMILARITY_CEILING}）:\n${list}\n遮住名字读者分不出是谁在说话。回到角色记忆里的"语言风格"，给他们不同的句长、口头禅和用词层次。\n    各角色画像:\n${profileLines}`,
    }
  }

  const closest = voices.pairs[0]
  return {
    id: 'character_voices',
    title: '对话可辨识度',
    status: 'pass',
    detail: `${voices.profiles.length} 位角色的对话分布可区分，最接近的一对 ${closest?.a} ↔ ${closest?.b} 相似度 ${closest?.similarity.toFixed(3)}。\n${profileLines}`,
  }
}

function checkForeshadowing(
  items: ForeshadowingItem[] | undefined,
  chapterCount: number,
): ManuscriptCheck {
  if (!items) {
    return {
      id: 'foreshadowing',
      title: '伏笔回收',
      status: 'skipped',
      detail:
        '未提供伏笔台账。写一份 meta/foreshadowing.json（id / description / planted / plannedPayoff / paidOff），伏笔状态就不必靠记忆维护。',
    }
  }
  if (items.length === 0) {
    return {
      id: 'foreshadowing',
      title: '伏笔回收',
      status: 'fail',
      detail: `台账是空的，但已经写了 ${chapterCount} 章。一部没有任何伏笔的长篇，要么是台账没在维护，要么是结构上确实没有埋任何东西——两种情况都需要处理。`,
    }
  }

  const overdue = items.filter(
    i =>
      !i.paidOff &&
      i.plannedPayoff != null &&
      chapterCount >= i.plannedPayoff,
  )
  const stale = items.filter(
    i =>
      !i.paidOff &&
      i.plannedPayoff == null &&
      chapterCount - i.planted >= FORESHADOWING_STALE_AFTER,
  )
  const open = items.filter(i => !i.paidOff)

  if (overdue.length > 0 || stale.length > 0) {
    const lines: string[] = []
    for (const i of overdue) {
      lines.push(
        `      ${i.id}（第 ${i.planted} 章埋，计划第 ${i.plannedPayoff} 章回收，已到第 ${chapterCount} 章仍未回收）: ${i.description}`,
      )
    }
    for (const i of stale) {
      lines.push(
        `      ${i.id}（第 ${i.planted} 章埋，至今 ${chapterCount - i.planted} 章无回收计划）: ${i.description}`,
      )
    }
    return {
      id: 'foreshadowing',
      title: '伏笔回收',
      status: 'fail',
      detail: `${overdue.length + stale.length} 条伏笔逾期或悬空:\n${lines.join('\n')}`,
    }
  }

  return {
    id: 'foreshadowing',
    title: '伏笔回收',
    status: 'pass',
    detail: `${items.length} 条伏笔，${items.length - open.length} 条已回收，${open.length} 条按计划待回收。`,
  }
}

export function checkManuscript(
  dialogueBySpeaker: Map<string, string[]>,
  chapterCount: number,
  foreshadowing?: ForeshadowingItem[],
): ManuscriptReport {
  if (chapterCount === 0) {
    return {
      verdict: 'incomplete',
      reason: '目录下没有找到章节文件。',
      checks: [],
      chapterCount: 0,
    }
  }

  const voices = analyzeVoices(dialogueBySpeaker)
  const checks = [
    checkVoices(voices),
    checkForeshadowing(foreshadowing, chapterCount),
  ]

  const failed = checks.filter(c => c.status === 'fail')
  return {
    verdict: failed.length > 0 ? 'needs_revision' : 'clean',
    reason:
      failed.length > 0
        ? `${failed.length} 项需要处理: ${failed.map(c => c.id).join('、')}。`
        : `${chapterCount} 章，机器可查的跨章问题未发现。`,
    checks,
    voices,
    chapterCount,
  }
}

// ── Formatting ────────────────────────────────────────────────────

const MARKER: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✗',
  skipped: '–',
}

function renderChecks(checks: ManuscriptCheck[]): string[] {
  const lines: string[] = []
  for (const check of checks) {
    lines.push(`${MARKER[check.status]} ${check.title}`)
    for (const detailLine of check.detail.split('\n')) {
      lines.push(`    ${detailLine}`)
    }
  }
  return lines
}

export function formatChapterReport(report: ChapterReport): string {
  const a = report.analysis
  const lines = [
    `manuscript_check chapter — ${report.file}`,
    `裁定: ${report.verdict === 'clean' ? 'CLEAN' : report.verdict === 'needs_revision' ? 'NEEDS_REVISION' : 'INCOMPLETE'} — ${report.reason}`,
    '',
    `字数 ${a.characters.toLocaleString()} · 对话 ${(a.dialogueRatio * 100).toFixed(1)}% · 说话人 ${a.speakers.length} 位 · 感官 ${a.sensory.present.length}/5`,
    '',
    ...renderChecks(report.checks),
    '',
    '开篇 200 字:',
    `    ${a.opening.replace(/\n/g, ' ')}`,
    '收尾 200 字:',
    `    ${a.closing.replace(/\n/g, ' ')}`,
    '',
    '开篇钩子和章末悬念是否成立，需要你自己读上面两段判断——这两项无法由模式匹配裁定。',
  ]
  return lines.join('\n')
}

export function formatManuscriptReport(report: ManuscriptReport): string {
  return [
    `manuscript_check manuscript — ${report.chapterCount} 章`,
    `裁定: ${report.verdict === 'clean' ? 'CLEAN' : report.verdict === 'needs_revision' ? 'NEEDS_REVISION' : 'INCOMPLETE'} — ${report.reason}`,
    '',
    ...renderChecks(report.checks),
  ].join('\n')
}
