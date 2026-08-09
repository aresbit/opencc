/**
 * Chapter narration — the part where a chronicle is most tempting to invent.
 *
 * The brief is "tell it like a novel", and prose about motive and mood is
 * exactly what a model will produce without evidence if nothing stops it. The
 * rule this module enforces is the one agreed with the user:
 *
 *   - a factual sentence MUST cite a source that resolves; one that does not
 *     resolve counts as no citation at all, and the paragraph is dropped;
 *   - anything about motive, feeling or causation is allowed, but only when
 *     flagged `speculative`, and it renders as a visibly separate block;
 *   - if speculation exceeds SPECULATION_LIMIT of the chapter, the chapter is
 *     reported as under-evidenced rather than published as if it were history;
 *   - a chapter with nothing left is a reported failure, never filler prose.
 *
 * `validateChapter` is deliberately split from the network call so that every
 * rejection path is testable without one — see ./narrate.eval.ts.
 */

import { z } from 'zod/v4'
import { getDefaultSonnetModel } from '../../utils/model/model.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonParse } from '../../utils/slowOperations.js'

/**
 * Share of a chapter's paragraphs that may be speculation before the chapter
 * is treated as under-evidenced. This number is the line between a chronicle
 * and fan fiction; it is deliberately low.
 */
export const SPECULATION_LIMIT = 0.2

/** Maximum characters of carried-forward story state. */
export const STORY_STATE_BUDGET = 1200

export type Paragraph = {
  text: string
  /** Citation ids: `c:<hash>` commit, `i:<number>` issue/PR, `r:<tag>` release. */
  cites: string[]
  /** True when the paragraph asserts motive, feeling or causation. */
  speculative: boolean
}

export const paragraphSchema = z.object({
  text: z.string(),
  cites: z.array(z.string()).default([]),
  speculative: z.boolean().default(false),
})

/** The set of citation ids a chapter is allowed to use. */
export type CiteIndex = {
  commits: ReadonlySet<string>
  issues: ReadonlySet<string>
  releases: ReadonlySet<string>
}

export function makeCiteIndex(params: {
  commits?: readonly string[]
  issues?: readonly (string | number)[]
  releases?: readonly string[]
}): CiteIndex {
  return {
    commits: new Set((params.commits ?? []).map(s => s.trim().toLowerCase())),
    issues: new Set((params.issues ?? []).map(s => String(s).trim())),
    releases: new Set((params.releases ?? []).map(s => s.trim().toLowerCase())),
  }
}

/**
 * Resolve one citation against the index.
 *
 * Commit hashes may be cited at any prefix length, so matching runs in both
 * directions — a 7-character citation resolves against an 8-character known
 * hash and vice versa. Issues and releases are identifiers, not prefixes, and
 * must match exactly; accepting a prefix there would let `i:1` resolve against
 * issue 1234.
 */
export function resolveCite(cite: string, index: CiteIndex): boolean {
  const raw = cite.trim()
  const sep = raw.indexOf(':')
  if (sep <= 0) return false
  const kind = raw.slice(0, sep).toLowerCase()
  const value = raw.slice(sep + 1).trim()
  if (!value) return false

  switch (kind) {
    case 'c': {
      const v = value.toLowerCase()
      // A one- or two-character "hash" matches almost anything; require enough
      // of a prefix that the citation actually identifies a commit.
      if (v.length < 4) return false
      return [...index.commits].some(k => k.startsWith(v) || v.startsWith(k))
    }
    case 'i':
      return index.issues.has(value.replace(/^#/, ''))
    case 'r':
      return index.releases.has(value.toLowerCase())
    default:
      return false
  }
}

export type ChapterValidation = {
  ok: boolean
  paragraphs: Paragraph[]
  /** Paragraphs removed, with the reason, for the chapter's audit trail. */
  dropped: string[]
  warnings: string[]
  error?: string
}

/**
 * Keep only paragraphs that earn their place.
 *
 * Split from the network call so every rejection path is testable. A fabricated
 * citation is treated exactly like a missing one: the citation exists so a
 * reader can check it, and one that does not resolve has not been checked.
 */
export function validateChapter(raw: unknown, index: CiteIndex): ChapterValidation {
  const parsed = z
    .object({ paragraphs: z.array(z.unknown()).default([]) })
    .safeParse(raw)

  if (!parsed.success) {
    return {
      ok: false,
      paragraphs: [],
      dropped: [],
      warnings: [],
      error: '章节输出不符合预期结构',
    }
  }

  const dropped: string[] = []
  const warnings: string[] = []
  const kept: Paragraph[] = []

  for (const item of parsed.data.paragraphs) {
    const p = paragraphSchema.safeParse(item)
    if (!p.success) {
      dropped.push('（一个段落的结构无法解析）')
      continue
    }
    const para = p.data
    const text = para.text.trim()
    if (!text) continue

    const resolved = para.cites.filter(c => resolveCite(c, index))

    if (!para.speculative && resolved.length === 0) {
      dropped.push(`${text.slice(0, 60)}…（无可解析引用）`)
      continue
    }
    // A speculative paragraph does not need a citation, but any citation it
    // does carry must still resolve — otherwise it reads as sourced when it
    // is not.
    kept.push({ ...para, text, cites: resolved })
  }

  if (kept.length === 0) {
    return {
      ok: false,
      paragraphs: [],
      dropped,
      warnings,
      error:
        dropped.length > 0
          ? `本章所有段落都缺少可解析引用（丢弃 ${dropped.length} 段）`
          : '本章未生成任何段落',
    }
  }

  const speculativeCount = kept.filter(p => p.speculative).length
  const ratio = speculativeCount / kept.length
  if (ratio > SPECULATION_LIMIT) {
    warnings.push(
      `推测段落占比 ${Math.round(ratio * 100)}%，超过 ${Math.round(SPECULATION_LIMIT * 100)}% 上限：本章证据不足，叙述应据此打折。`,
    )
  }

  return { ok: true, paragraphs: kept, dropped, warnings }
}

// ── generation ────────────────────────────────────────────────────────

const SYSTEM = `你在写一部项目编年史中的一章。读者读它是为了知道这个项目当年真实发生了什么。

你会收到一个纪元的证据账本：提交、release、issue/PR 讨论，以及上一章结束时的故事状态。

写法要求：
- 用叙事散文写，有时间线、有转折、有人物。不要写成 changelog 或要点列表。
- 每个段落都要标注它依据的证据 id（cites），使用账本中给出的 id 原文：
  提交 c:<短哈希>、issue/PR i:<编号>、release r:<标签名>。
- 事实性段落（发生了什么、谁做的、什么时候、代码怎么变的）必须至少有一条 cites。
  给不出引用的事实，就不要写。
- 关于动机、情绪、因果的判断（"他大概是受够了手工配置"）允许写，但必须把
  speculative 设为 true。这类内容会被单独标记呈现给读者。
- 不要把 speculative 当作绕过引用的通道。推测占比过高的章节会被判定证据不足。
- 不要复述提交信息的字面内容；说出它意味着什么。
- 证据稀薄时，宁可写得短。

同时产出 storyState：不超过 ${STORY_STATE_BUDGET} 字，写明本纪元结束时系统已经有什么、
哪些问题悬而未决、当前的主要人物。它会作为下一章的前情，不进入正文。

再产出 title：这一章的标题，像小说的章节名，不要用版本号当标题。`

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    paragraphs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          cites: { type: 'array', items: { type: 'string' } },
          speculative: { type: 'boolean' },
        },
        required: ['text', 'cites', 'speculative'],
        additionalProperties: false,
      },
    },
    storyState: { type: 'string' },
  },
  required: ['title', 'paragraphs', 'storyState'],
  additionalProperties: false,
} as const

export type NarratedChapter = ChapterValidation & {
  title: string
  storyState: string
}

/**
 * The closing lessons.
 *
 * Written from the accumulated story states rather than from the raw log: by
 * this point the per-chapter evidence has already been checked, and asking for
 * conclusions over the whole history from the ledger again would just invite
 * new unsourced claims at the one place a reader is most likely to quote.
 */
export async function narrateEpilogue(params: {
  repoName: string
  storyStates: readonly string[]
  panoramaSummary: string
  signal: AbortSignal
}): Promise<string[]> {
  if (params.storyStates.length === 0) return []
  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system:
        '你在为一部项目编年史写结语。给出三到五条经验总结，每条一句话，' +
        '基于给定的各章状态，不要引入新的事实细节。可写的母题：个人与团队、' +
        '早期架构决策的长期影响、社区呼声如何决定方向、技术栈随时代迁移、' +
        '项目定位。不要空话，不要重复章节标题。',
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `仓库：${params.repoName}\n${params.panoramaSummary}\n\n各章结束时的状态：\n${params.storyStates
            .map((s, i) => `第 ${i + 1} 章：${s}`)
            .join('\n\n')}`,
        },
      ],
      max_tokens: 1536,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { lessons: { type: 'array', items: { type: 'string' } } },
          required: ['lessons'],
          additionalProperties: false,
        },
      },
      signal: params.signal,
      querySource: 'redo_chronicle_epilogue',
    })
    const block = result.content.find(b => b.type === 'text')
    if (!block || block.type !== 'text') return []
    const raw = jsonParse(block.text) as { lessons?: unknown }
    if (!Array.isArray(raw.lessons)) return []
    return raw.lessons
      .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
      .map(l => l.trim())
      .slice(0, 5)
  } catch {
    // A missing epilogue is rendered as such; it must not fail the document.
    return []
  }
}

export async function narrateChapter(params: {
  repoName: string
  eraOrdinal: number
  /** Rendered evidence ledger for this era. */
  ledger: string
  /** Story state carried from the previous chapter; empty for chapter one. */
  previousState: string
  index: CiteIndex
  signal: AbortSignal
}): Promise<NarratedChapter> {
  const fallbackTitle = `第 ${params.eraOrdinal} 章`

  if (!params.ledger.trim()) {
    return {
      ok: false,
      title: fallbackTitle,
      paragraphs: [],
      storyState: params.previousState,
      dropped: [],
      warnings: [],
      error: '本纪元没有可用证据',
    }
  }

  const previous = params.previousState.trim()
    ? `## 前情（上一章结束时的状态）\n${params.previousState.trim()}\n\n`
    : ''

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SYSTEM,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `仓库：${params.repoName}\n这是第 ${params.eraOrdinal} 章。\n\n${previous}## 本纪元证据账本\n${params.ledger}`,
        },
      ],
      max_tokens: 8192,
      output_format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      signal: params.signal,
      querySource: 'redo_chronicle',
    })

    const block = result.content.find(b => b.type === 'text')
    if (!block || block.type !== 'text') {
      return {
        ok: false,
        title: fallbackTitle,
        paragraphs: [],
        storyState: params.previousState,
        dropped: [],
        warnings: [],
        error: '章节生成未返回文本',
      }
    }

    const raw = jsonParse(block.text) as Record<string, unknown>
    const validated = validateChapter(raw, params.index)
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : fallbackTitle
    const storyState =
      typeof raw.storyState === 'string' && raw.storyState.trim()
        ? raw.storyState.trim().slice(0, STORY_STATE_BUDGET)
        // A failed chapter must not wipe the thread for the next one.
        : params.previousState

    return { ...validated, title, storyState }
  } catch (e) {
    return {
      ok: false,
      title: fallbackTitle,
      paragraphs: [],
      storyState: params.previousState,
      dropped: [],
      warnings: [],
      error: `章节生成失败：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
