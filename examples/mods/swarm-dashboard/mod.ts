/**
 * swarm-dashboard — the swarm, made visible.
 *
 * Two subsystems already write durable state that nobody reads:
 *
 *   <config>/coroutines/<team>/state.json      every coroutine, its state,
 *                                              worker, protocol cursor and
 *                                              recovery attempts
 *   <config>/actors/<team>/*.presence.json     a heartbeat per live address
 *
 * This mod is a reader. It re-reads both roots on an interval, caches one
 * snapshot, and hands the same snapshot to two consumers: a desktop panel (a
 * declarative tree — the host draws it) and the `swarm.state` service (other
 * mods read it).
 *
 * Two deliberate choices:
 *
 *   - The timer is unref'd. A mod must not be the reason a headless session
 *     never exits; the panel is a view, not a daemon.
 *   - Every failure is swallowed into the snapshot. A partially written
 *     state.json (the store holds a lock while it rewrites) is a normal thing
 *     to see, and a render that throws would be quarantined as a broken mod.
 */

import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

type CoroutineRow = {
  id: string
  name: string
  team: string
  state: string
  worker: string
  attempts: number
  noProgress: number
  ageSeconds: number
  task: string
}

type ActorRow = {
  name: string
  team: string
  address: string
  lastSeenAt: string
  ageSeconds: number
  alive: boolean
}

type Snapshot = {
  at: string
  counts: Record<string, number>
  coroutines: CoroutineRow[]
  terminal: number
  actors: ActorRow[]
  alive: number
  errors: string[]
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    return []
  }
}

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function coroutinesFrom(root: string, staleAfterMs: number, now: number, errors: string[]) {
  const counts: Record<string, number> = {}
  const rows: CoroutineRow[] = []
  let terminal = 0

  for (const team of listDirs(root)) {
    const state = readJson(join(root, team, 'state.json'))
    if (!state || typeof state.coroutines !== 'object' || !state.coroutines) continue
    for (const id of Object.keys(state.coroutines)) {
      const record = state.coroutines[id]
      if (!record) continue
      const name = String(record.name ?? id)
      const stateName = String(record.state ?? 'unknown')
      counts[stateName] = (counts[stateName] ?? 0) + 1
      if (TERMINAL.has(stateName)) {
        terminal++
        continue
      }
      const createdAt = Date.parse(String(record.createdAt ?? '')) || now
      const recovery = record.recovery ?? {}
      rows.push({
        id: String(record.id ?? id),
        name,
        team: String(record.team ?? team),
        state: stateName,
        worker: String(record.worker ?? ''),
        attempts: Number(recovery.attempts ?? 0),
        noProgress: Number(recovery.noProgress ?? 0),
        ageSeconds: Math.max(0, Math.round((now - createdAt) / 1000)),
        task: String(record.task ?? '').slice(0, 100),
      })
    }
  }
  return { counts, rows: rows.sort((a, b) => b.ageSeconds - a.ageSeconds), terminal }
}

function actorsFrom(root: string, staleAfterMs: number, now: number) {
  const rows: ActorRow[] = []
  for (const team of listDirs(root)) {
    let files: string[] = []
    try {
      files = readdirSync(join(root, team)).filter(f => f.endsWith('.presence.json'))
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(root, team, file)
      const data = readJson(path) ?? {}
      const name = file.replace(/\.presence\.json$/, '')
      const lastSeenAt = String(data.lastSeenAt ?? '')
      const seen = Date.parse(lastSeenAt) || statMtime(path)
      const ageSeconds = Math.max(0, Math.round((now - seen) / 1000))
      rows.push({
        name,
        team,
        address: String(data.address ?? `actor://${team}/${name}`),
        lastSeenAt,
        ageSeconds,
        alive: now - seen <= staleAfterMs,
      })
    }
  }
  return rows.sort((a, b) => Number(b.alive) - Number(a.alive) || a.ageSeconds - b.ageSeconds)
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function compactAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

export function register(on: any, options: any, ctx: any) {
  const staleAfterMs = Number(options?.staleAfterMs ?? 300_000)
  const refreshMs = Number(options?.refreshMs ?? 5000)
  // Resolved here, not at import: the config directory belongs to the process
  // that loads the mod, and an import-time constant would pin whichever value
  // happened to be in the environment first.
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const coroutineRoot = join(config, 'coroutines')
  const actorRoot = join(config, 'actors')
  let snapshot: Snapshot = { at: '', counts: {}, coroutines: [], terminal: 0, actors: [], alive: 0, errors: [] }

  const collect = (): Snapshot => {
    const now = Date.now()
    const errors: string[] = []
    const c = coroutinesFrom(coroutineRoot, staleAfterMs, now, errors)
    const actors = actorsFrom(actorRoot, staleAfterMs, now)
    return {
      at: new Date(now).toISOString(),
      counts: c.counts,
      coroutines: c.rows,
      terminal: c.terminal,
      actors,
      alive: actors.filter(a => a.alive).length,
      errors,
    }
  }

  const tick = () => {
    try {
      snapshot = collect()
      ctx.desktop?.refresh?.()
    } catch {
      // A store mid-rewrite is not a broken mod.
    }
  }

  tick()
  const timer = setInterval(tick, refreshMs)
  ;(timer as any)?.unref?.()

  // `?.` on purpose: the panel and the commands stand on their own, and a
  // build that predates mod services is still a fine host for them — the
  // service is what another mod gets when the engine has one.
  ctx.provide?.('swarm.state', {
    get: () => snapshot,
    refresh: () => {
      tick()
      return snapshot
    },
    counts: () => snapshot.counts,
  })

  const tree = () => {
    const s = snapshot
    const metrics = [
      { label: 'coroutines', value: s.coroutines.length + s.terminal },
      { label: 'active', value: s.coroutines.length, tone: s.coroutines.length > 0 ? 'accent' : 'default' },
      { label: 'done', value: s.counts.done ?? 0 },
      { label: 'failed', value: s.counts.failed ?? 0, tone: (s.counts.failed ?? 0) > 0 ? 'danger' : 'default' },
      { label: 'peers live', value: `${s.alive}/${s.actors.length}`, tone: s.alive > 0 ? 'success' : 'default' },
    ]
    const children: any[] = [{ type: 'Metrics', items: metrics }]

    if (s.coroutines.length > 0) {
      children.push({
        type: 'Table',
        columns: [
          { key: 'name', label: 'coroutine' },
          { key: 'state', label: 'state' },
          { key: 'worker', label: 'worker' },
          { key: 'recovery', label: 'recovery', align: 'right' },
          { key: 'age', label: 'age', align: 'right' },
        ],
        rows: s.coroutines.slice(0, 12).map(r => ({
          name: r.name,
          state: r.state,
          worker: r.worker.replace(/^actor:\/\/[^/]+\//, ''),
          recovery: r.attempts > 0 ? `${r.attempts}/3 · ${r.noProgress} np` : '—',
          age: compactAge(r.ageSeconds),
        })),
        caption: s.coroutines.length > 12 ? `showing 12 of ${s.coroutines.length}` : undefined,
      })
    }

    if (s.actors.length > 0) {
      children.push({
        type: 'Table',
        columns: [
          { key: 'name', label: 'peer' },
          { key: 'team', label: 'team' },
          { key: 'status', label: 'status' },
          { key: 'seen', label: 'last seen', align: 'right' },
        ],
        rows: s.actors.slice(0, 10).map(a => ({
          name: a.name,
          team: a.team,
          status: a.alive ? 'live' : 'stale',
          seen: compactAge(a.ageSeconds),
        })),
      })
    }

    if (s.coroutines.length === 0 && s.actors.length === 0) {
      children.push({ type: 'Text', text: 'No coroutines or actors on disk yet.', tone: 'muted' })
    }

    return { title: 'Swarm', tree: { type: 'Box', direction: 'column', children } }
  }

  ctx.desktop?.slot?.('panel', tree)

  on('command.invoke', { command: 'show' }, () => {
    snapshot = collect()
    return snapshot
  })
}
