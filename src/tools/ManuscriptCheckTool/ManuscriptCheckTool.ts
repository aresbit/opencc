import { readdir, readFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { DESCRIPTION, getPrompt, MANUSCRIPT_CHECK_TOOL_NAME } from './prompt.js'
import { extractDialogue } from './analyze.js'
import {
  checkChapter,
  checkManuscript,
  DEFAULT_THRESHOLDS,
  formatChapterReport,
  formatManuscriptReport,
  type ChapterReport,
  type ForeshadowingItem,
  type ManuscriptReport,
} from './check.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['chapter', 'manuscript'])
      .describe(
        '"chapter" 检查单章；"manuscript" 检查跨章问题（角色声音辨识度、伏笔回收）。',
      ),
    path: z
      .string()
      .optional()
      .describe('action="chapter" 时必填：章节文件路径。'),
    chaptersDir: z
      .string()
      .optional()
      .describe('action="manuscript" 时必填：章节目录。'),
    foreshadowingPath: z
      .string()
      .optional()
      .describe(
        '伏笔台账 JSON（默认在 chaptersDir 同级的 meta/foreshadowing.json 查找）。',
      ),
    minDialogueRatio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('对话占比下限，默认 0.2。'),
    minNonVisualSenses: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe('非视觉感官种类下限，默认 2。'),
    minCharacters: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('章节字数下限。不填则不判定长度。'),
    maxCharacters: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('章节字数上限。不填则不判定长度。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const checkSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    detail: z.string(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z
      .boolean()
      .describe('裁定为 clean 时为 true。needs_revision / incomplete 为 false。'),
    action: z.string(),
    verdict: z.string().describe('clean | needs_revision | incomplete'),
    reason: z.string(),
    message: z.string().describe('完整报告'),
    checks: z.array(checkSchema()).optional(),
    stats: z
      .object({
        characters: z.number(),
        dialogueRatio: z.number(),
        dialogueLines: z.number(),
        speakers: z.array(z.string()),
        sensesPresent: z.array(z.string()),
        tellCount: z.number(),
      })
      .optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/** Relative paths stay inside the working directory. */
function resolveUserPath(input: string): string {
  if (isAbsolute(input)) return resolve(input)
  const base = getCwd()
  const resolved = resolve(base, input)
  if (relative(base, resolved).startsWith('..')) {
    throw new Error(`拒绝访问 "${input}"：相对路径不得越出 ${base}。`)
  }
  return resolved
}

function failure(action: string, error: string): { data: Output } {
  return {
    data: {
      success: false,
      action,
      verdict: 'incomplete',
      reason: error,
      message: `manuscript_check ${action} 无法运行: ${error}`,
      error,
    },
  }
}

function toChecks(report: ChapterReport | ManuscriptReport) {
  return report.checks.map(c => ({
    id: c.id,
    title: c.title,
    status: c.status,
    detail: c.detail,
  }))
}

const CHAPTER_FILE = /\.(md|markdown|txt)$/i

export const ManuscriptCheckTool = buildTool({
  name: MANUSCRIPT_CHECK_TOOL_NAME,
  searchHint:
    'check a Chinese manuscript for AI tells, dialogue ratio, sensory coverage, character voice distinctiveness and foreshadowing payoff',
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
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ManuscriptCheck'
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `manuscript_check ${input.action} ${input.path ?? input.chaptersDir ?? ''}`
  },
  renderToolUseMessage(input: Partial<Input>) {
    const target = input.path ?? input.chaptersDir
    if (!input.action || !target) return null
    return `manuscript_check ${input.action} ${target}`
  },
  async call(input, _context) {
    return input.action === 'manuscript'
      ? runManuscript(input)
      : runChapter(input)
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    // The full report goes back regardless of verdict — needs_revision is
    // precisely when the per-check detail is what the model has to act on.
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runChapter(input: Input): Promise<{ data: Output }> {
  if (!input.path) {
    return failure('chapter', 'action="chapter" 需要 path。')
  }

  let path: string
  try {
    path = resolveUserPath(input.path)
  } catch (error) {
    return failure('chapter', error instanceof Error ? error.message : String(error))
  }

  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return failure('chapter', `找不到章节文件: ${path}`)
  }

  const report = checkChapter(input.path, text, {
    minDialogueRatio:
      input.minDialogueRatio ?? DEFAULT_THRESHOLDS.minDialogueRatio,
    minNonVisualSenses:
      input.minNonVisualSenses ?? DEFAULT_THRESHOLDS.minNonVisualSenses,
    minCharacters: input.minCharacters,
    maxCharacters: input.maxCharacters,
  })

  return {
    data: {
      success: report.verdict === 'clean',
      action: 'chapter',
      verdict: report.verdict,
      reason: report.reason,
      message: formatChapterReport(report),
      checks: toChecks(report),
      stats: {
        characters: report.analysis.characters,
        dialogueRatio: report.analysis.dialogueRatio,
        dialogueLines: report.analysis.dialogueLines,
        speakers: report.analysis.speakers,
        sensesPresent: report.analysis.sensory.present,
        tellCount: report.analysis.tells.reduce((s, t) => s + t.count, 0),
      },
    },
  }
}

async function loadForeshadowing(
  explicitPath: string | undefined,
  chaptersDir: string,
): Promise<ForeshadowingItem[] | undefined> {
  const candidates = explicitPath
    ? [resolveUserPath(explicitPath)]
    : [
        join(chaptersDir, '..', 'meta', 'foreshadowing.json'),
        join(chaptersDir, 'foreshadowing.json'),
      ]

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as ForeshadowingItem[]
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

async function runManuscript(input: Input): Promise<{ data: Output }> {
  if (!input.chaptersDir) {
    return failure('manuscript', 'action="manuscript" 需要 chaptersDir。')
  }

  let dir: string
  try {
    dir = resolveUserPath(input.chaptersDir)
  } catch (error) {
    return failure(
      'manuscript',
      error instanceof Error ? error.message : String(error),
    )
  }

  let entries: string[]
  try {
    entries = (await readdir(dir)).filter(f => CHAPTER_FILE.test(f)).sort()
  } catch {
    return failure('manuscript', `找不到章节目录: ${dir}`)
  }

  const dialogueBySpeaker = new Map<string, string[]>()
  for (const entry of entries) {
    const text = await readFile(join(dir, entry), 'utf-8').catch(() => '')
    for (const line of extractDialogue(text)) {
      if (!line.speaker) continue
      const bucket = dialogueBySpeaker.get(line.speaker) ?? []
      bucket.push(line.text)
      dialogueBySpeaker.set(line.speaker, bucket)
    }
  }

  const foreshadowing = await loadForeshadowing(
    input.foreshadowingPath,
    dir,
  ).catch(() => undefined)

  const report = checkManuscript(
    dialogueBySpeaker,
    entries.length,
    foreshadowing,
  )

  return {
    data: {
      success: report.verdict === 'clean',
      action: 'manuscript',
      verdict: report.verdict,
      reason: report.reason,
      message: formatManuscriptReport(report),
      checks: toChecks(report),
    },
  }
}
