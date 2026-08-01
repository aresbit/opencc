/**
 * Markdown serialization for the task graph.
 *
 * The graph lives in a `## Tasks` table inside the plan file, so the plan stays
 * a document a human reads and edits while also being the tool's source of
 * truth. A separate JSON sidecar would have been easier to parse and would
 * have drifted from the markdown within a day.
 *
 * Parsing is deliberately forgiving — humans hand-edit these tables, and a plan
 * that fails to parse because someone wrote "none" instead of "—" is worse than
 * useless. Serialization is strict and canonical so round-trips are stable.
 */

import {
  STORED_STATUSES,
  type StoredStatus,
  type Task,
  type TaskGraph,
} from './taskGraph.js'

export const TASKS_HEADING = 'Tasks'

const HEADER_ROW = '| ID | Task | Status | Depends On | Verify |'
const DIVIDER_ROW = '|----|------|--------|------------|--------|'
const NO_DEPS = '—'

/** Extract the `## Tasks` table from a plan file. Missing section → empty graph. */
export function parseTaskGraph(content: string): TaskGraph {
  const lines = content.split('\n')
  const headingRe = new RegExp(`^##\\s+${TASKS_HEADING}\\s*$`)
  const start = lines.findIndex(l => headingRe.test(l))
  if (start === -1) return { tasks: [] }

  const tasks: Task[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,2}\s/.test(line)) break // next section ends the table
    const task = parseRow(line)
    if (task) tasks.push(task)
  }
  return { tasks }
}

function parseRow(line: string): Task | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  // Skip the header and the |---|---| divider.
  if (/^\|[\s:-]*\|[\s:|-]*$/.test(trimmed)) return null

  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())

  if (cells.length < 2) return null
  const [rawId, rawTitle, rawStatus, rawDeps, rawVerify] = cells
  if (!rawId || /^id$/i.test(rawId)) return null

  return {
    id: rawId,
    title: rawTitle ?? '',
    status: parseStatus(rawStatus),
    dependsOn: parseDeps(rawDeps),
    ...(rawVerify && !isBlank(rawVerify) ? { verify: rawVerify } : {}),
  }
}

function parseStatus(raw: string | undefined): StoredStatus {
  const s = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const hit = STORED_STATUSES.find(v => v === s)
  if (hit) return hit
  // `ready` and `blocked` are derived, but a human may well have typed one
  // into the table. Both mean "not started", so they land on `pending` and the
  // graph recomputes the real answer from the dependency edges.
  if (s === 'ready' || s === 'blocked' || s === 'todo' || s === '') return 'pending'
  if (s === 'done' || s === 'completed') return 'complete'
  if (s === 'wip' || s === 'doing' || s === 'active') return 'in_progress'
  return 'pending'
}

function parseDeps(raw: string | undefined): string[] {
  if (!raw || isBlank(raw)) return []
  return raw
    .split(/[,\s]+/)
    .map(d => d.trim())
    .filter(d => d && !isBlank(d))
}

/** The many ways a human writes "nothing here". */
function isBlank(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === '' || v === '—' || v === '-' || v === '–' || v === 'none' || v === 'n/a' || v === '(none)'
}

export function serializeTaskGraph(graph: TaskGraph): string {
  const rows = graph.tasks.map(t =>
    `| ${t.id} | ${t.title} | ${t.status} | ${t.dependsOn.length > 0 ? t.dependsOn.join(', ') : NO_DEPS} | ${t.verify ?? NO_DEPS} |`,
  )
  return [HEADER_ROW, DIVIDER_ROW, ...rows].join('\n')
}

/**
 * Replace the `## Tasks` section in a plan, or append one if absent.
 * Everything outside the section is preserved byte-for-byte — the plan holds
 * human prose the tool has no business rewriting.
 */
export function writeTaskGraph(content: string, graph: TaskGraph): string {
  const table = serializeTaskGraph(graph)
  const lines = content.split('\n')
  const headingRe = new RegExp(`^##\\s+${TASKS_HEADING}\\s*$`)
  const start = lines.findIndex(l => headingRe.test(l))

  if (start === -1) {
    const suffix = content.endsWith('\n') ? '' : '\n'
    return `${content}${suffix}\n## ${TASKS_HEADING}\n\n${table}\n`
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i
      break
    }
  }

  return [
    ...lines.slice(0, start + 1),
    '',
    table,
    '',
    ...lines.slice(end),
  ].join('\n')
}

/** Next free `T<n>` id for the graph. */
export function nextTaskId(graph: TaskGraph): string {
  let max = 0
  for (const t of graph.tasks) {
    const m = /^T(\d+)$/.exec(t.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `T${max + 1}`
}
