/**
 * awr-fleet — the roster, as something other mods can ask.
 *
 * The useful question in pipeline upkeep is never "what does the dashboard
 * say" but "may I touch this robot right now". That answer needs the roster
 * as data, not as a screen: a serial, a status, whether an OTA is in flight,
 * and how old the whole picture is. So this mod provides `awr.fleet` and
 * draws a panel from the same object.
 *
 * Two honesty rules, both learned from reading rosters that lied:
 *   - `sample: true` in the file means the robots are placeholders. The panel
 *     says so; a fabricated fleet that looks live is worse than no panel.
 *   - `stale()` is part of the service. A roster from this morning says
 *     nothing about a robot now, and a consumer that ignores the age will
 *     eventually gate the wrong machine.
 *
 * Read-only: this mod never writes the roster.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

type Ota = { version?: string; stage?: string; progress?: number }
type Robot = {
  serial_number: string
  status?: number
  job_status?: number
  workspace_id?: string
  board_sn?: string
  ota?: Ota
}
type Roster = { updated_at?: string; sample?: boolean; robots?: Robot[] }

const DEFAULT_PATH = join(homedir(), '.awr', 'robots.json')

function compactAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return '?'
  if (seconds < 90) return `${Math.round(seconds)}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

export function register(on: any, options: any, ctx: any) {
  const path = String(process.env.AWR_ROSTER || DEFAULT_PATH)
  const staleAfterMs = Number(options?.staleAfterMs ?? 600_000)
  const refreshMs = Number(options?.refreshMs ?? 15000)

  let roster: Roster = {}
  let readAt = 0
  let error: string | null = null

  const read = () => {
    try {
      roster = JSON.parse(readFileSync(path, 'utf8')) as Roster
      readAt = Date.now()
      error = null
    } catch (e: any) {
      error = String(e?.message ?? e)
    }
  }

  const robots = (): Robot[] => (Array.isArray(roster.robots) ? roster.robots : [])

  const updatedAt = () => {
    const parsed = Date.parse(String(roster.updated_at ?? ''))
    return Number.isFinite(parsed) ? parsed : readAt
  }

  const ageSeconds = () => Math.round((Date.now() - updatedAt()) / 1000)

  const snapshot = () => ({
    path,
    loadedAt: readAt ? new Date(readAt).toISOString() : null,
    updatedAt: roster.updated_at ?? null,
    ageSeconds: ageSeconds(),
    stale: Date.now() - updatedAt() > staleAfterMs,
    sample: roster.sample === true,
    error,
    robots: robots(),
  })

  // `?.` on purpose: the panel and the commands stand on their own, and a
  // build that predates mod services is still a fine host for them — the
  // service is what another mod gets when the engine has one.
  ctx.provide?.('awr.fleet', {
    list: () => robots(),
    get: (serial: string) => robots().find(r => r.serial_number === serial) ?? null,
    snapshot,
    stale: () => Date.now() - updatedAt() > staleAfterMs,
    busy: () => robots().filter(r => (r.status ?? 0) !== 0 || (r.job_status ?? 0) !== 0),
    otaInFlight: () => robots().filter(r => r.ota && r.ota.stage && r.ota.stage !== 'done'),
  })

  const tick = () => {
    read()
    ctx.desktop?.refresh?.()
  }

  tick()
  const timer = setInterval(tick, refreshMs)
  ;(timer as any)?.unref?.()

  ctx.desktop?.slot?.('panel', () => {
    const s = snapshot()
    const children: any[] = []
    const inFlight = robots().filter(r => r.ota && r.ota.stage && r.ota.stage !== 'done').length

    children.push({
      type: 'Metrics',
      items: [
        { label: 'robots', value: robots().length },
        { label: 'ota in flight', value: inFlight, tone: inFlight > 0 ? 'accent' : 'default' },
        { label: 'roster age', value: compactAge(s.ageSeconds), tone: s.stale ? 'warn' : 'success' },
      ],
    })

    if (s.sample) {
      children.push({
        type: 'Callout',
        tone: 'info',
        text: 'This roster is marked sample: true — the robots below are placeholders, not a live fleet.',
      })
    }
    if (s.error) {
      children.push({ type: 'Callout', tone: 'danger', text: `Cannot read ${s.path}: ${s.error}` })
    }
    if (s.stale && !s.error) {
      children.push({
        type: 'Callout',
        tone: 'warn',
        text: `The roster has not been updated in ${compactAge(s.ageSeconds)}; it does not describe the fleet now.`,
      })
    }

    if (robots().length > 0) {
      children.push({
        type: 'Table',
        columns: [
          { key: 'serial', label: 'robot' },
          { key: 'status', label: 'status', align: 'right' },
          { key: 'job', label: 'job', align: 'right' },
          { key: 'workspace', label: 'workspace' },
          { key: 'ota', label: 'ota' },
        ],
        rows: robots().slice(0, 20).map(r => ({
          serial: r.serial_number,
          status: r.status ?? null,
          job: r.job_status ?? null,
          workspace: r.workspace_id ?? '—',
          ota: r.ota?.stage ? `${r.ota.version ?? '?'} · ${r.ota.stage}` : '—',
        })),
      })
    } else if (!s.error) {
      children.push({ type: 'Text', text: 'The roster has no robots.', tone: 'muted' })
    }

    return { title: 'AWR fleet', tree: { type: 'Box', direction: 'column', children } }
  })

  // Text, because a person reads this; another mod reads `awr.fleet` instead
  // of parsing the table.
  on('command.invoke', { command: 'fleet' }, () => {
    read()
    const s = snapshot()
    const lines = [
      `roster ${s.path}  updated ${s.updatedAt ?? '?'}  age ${compactAge(s.ageSeconds)}${s.stale ? ' (STALE)' : ''}${s.sample ? '  [sample data]' : ''}`,
    ]
    if (s.error) lines.push(`error: ${s.error}`)
    lines.push('serial\tstatus\tjob\tworkspace\tboard\tota')
    for (const r of robots()) {
      const ota = r.ota?.stage ? `${r.ota.version ?? '?'}/${r.ota.stage}${typeof r.ota.progress === 'number' ? ` ${Math.round(r.ota.progress * 100)}%` : ''}` : '-'
      lines.push([r.serial_number, r.status ?? '-', r.job_status ?? '-', r.workspace_id ?? '-', r.board_sn ?? '-', ota].join('\t'))
    }
    return lines.join('\n')
  })
}
