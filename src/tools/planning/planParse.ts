/**
 * Shared plan-file parsing for the planning tools (PMTool, SETool).
 *
 * Both tools were near-duplicates: each had its own `parsePhaseTotals`,
 * `exists`, checkbox counting, and template scaffolding. Beyond the
 * duplication, PMTool's control-checklist counter had a real bug — it counted
 * every `- [ ]` line in the whole charter, so the 10 milestone task checkboxes
 * were lumped in with the 5 anti-trap control items and "Controls 0/15" was
 * reported for a 5-item list. Consolidating the parsing here fixes it once and
 * gives both tools the same, tested behaviour.
 *
 * Everything is pure so the eval harness can score it against a labeled corpus
 * without touching the filesystem.
 */

export type PhaseStatus = 'complete' | 'in_progress' | 'pending'

export type PhaseTotals = {
  total: number
  complete: number
  inProgress: number
  pending: number
}

export type Checkbox = { checked: boolean; label: string }

/**
 * Count phases and their statuses.
 *
 * `headingWord` is "Milestone" for PMTool, "Phase" for SETool. The status
 * markers are the `**Status:** <state>` lines under each heading. When no
 * status markers exist, falls back to bare `[complete]`/`[in_progress]`/
 * `[pending]` tags (SETool's legacy format).
 */
export function parsePhaseTotals(content: string, headingWord: string): PhaseTotals {
  const headingRe = new RegExp(`###\\s+${escapeRegExp(headingWord)}`, 'g')
  const total = (content.match(headingRe) ?? []).length

  const statusMatches = [
    ...content.matchAll(/\*\*Status:\*\*\s*(complete|in_progress|pending)/g),
  ]

  let complete = 0
  let inProgress = 0
  let pending = 0

  if (statusMatches.length > 0) {
    for (const m of statusMatches) {
      const status = (m[1] ?? 'pending') as PhaseStatus
      if (status === 'complete') complete += 1
      else if (status === 'in_progress') inProgress += 1
      else pending += 1
    }
  } else {
    complete = (content.match(/\[complete\]/g) ?? []).length
    inProgress = (content.match(/\[in_progress\]/g) ?? []).length
    pending = (content.match(/\[pending\]/g) ?? []).length
  }

  return { total, complete, inProgress, pending }
}

/**
 * Extract the checkboxes under a single `## <heading>` section, stopping at
 * the next `##`/`#` heading. Section-scoped on purpose: this is what the
 * control-checklist counter needed and did not have.
 */
export function parseSectionCheckboxes(content: string, heading: string): Checkbox[] {
  // Line-based rather than one big regex: JS has no `\Z`, and a `$`-anchored
  // multiline lookahead matches the end of every line, not end-of-string, so
  // the section boundary is easier to get right by walking lines.
  const lines = content.split('\n')
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`)
  const start = lines.findIndex(l => headingRe.test(l))
  if (start === -1) return []

  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break // next h1/h2 ends the section
    body.push(lines[i])
  }
  return parseCheckboxes(body.join('\n'))
}

/** Every `- [ ] label` / `- [x] label` line in a block of text. */
export function parseCheckboxes(text: string): Checkbox[] {
  const out: Checkbox[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*- \[([ xX])\]\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ checked: m[1].toLowerCase() === 'x', label: m[2] })
  }
  return out
}

export type NextActions = {
  /** 1-based index of the phase the actions come from, or 0 if none. */
  phaseIndex: number
  phaseTitle: string
  /** The unchecked checkbox labels in that phase. */
  actions: string[]
}

/**
 * The orchestration primitive the tools were missing.
 *
 * `status` used to report only counts ("0/5 complete"), which tells the model
 * how much is left but not what to do. A planning tool that cannot answer
 * "what next?" is a progress bar, not an orchestrator. This finds the active
 * phase — the first `in_progress` one, else the first not-complete one — and
 * returns its unchecked items as the concrete next steps.
 */
export function deriveNextActions(content: string, headingWord: string): NextActions {
  const phases = splitPhases(content, headingWord)
  if (phases.length === 0) return { phaseIndex: 0, phaseTitle: '', actions: [] }

  const active =
    phases.find(p => p.status === 'in_progress') ??
    phases.find(p => p.status !== 'complete') ??
    phases[phases.length - 1]

  const unchecked = parseCheckboxes(active.body)
    .filter(c => !c.checked)
    .map(c => c.label)

  return {
    phaseIndex: active.index,
    phaseTitle: active.title,
    actions: unchecked,
  }
}

type Phase = { index: number; title: string; status: PhaseStatus; body: string }

/** Split a plan into its phase blocks, each with title, status and body. */
function splitPhases(content: string, headingWord: string): Phase[] {
  const re = new RegExp(
    `###\\s+${escapeRegExp(headingWord)}[^\\n]*`,
    'g',
  )
  const heads = [...content.matchAll(re)]
  const phases: Phase[] = []

  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index ?? 0
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? content.length) : content.length
    const block = content.slice(start, end)
    const titleLine = heads[i][0].replace(/^###\s+/, '').trim()
    const statusMatch = /\*\*Status:\*\*\s*(complete|in_progress|pending)/.exec(block)
    const status = (statusMatch?.[1] as PhaseStatus | undefined) ?? 'pending'
    phases.push({ index: i + 1, title: titleLine, status, body: block })
  }

  return phases
}

export function summarizeCheckboxes(boxes: Checkbox[]): {
  total: number
  checked: number
  unchecked: number
} {
  const total = boxes.length
  const checked = boxes.filter(b => b.checked).length
  return { total, checked, unchecked: total - checked }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
