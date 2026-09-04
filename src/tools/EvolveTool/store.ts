import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export interface Lesson {
  text: string
  /** verified = proven by outcome/test; gap = claimed but not yet proven. */
  evidence: 'verified' | 'gap'
}

export interface Reflection {
  id: string
  goal: string
  plan: string[]
  outcome: 'success' | 'partial' | 'failed'
  lessons: Lesson[]
  tags: string[]
  timestamp: string
}

export interface ReuseRecord {
  id: string
  reflectionId: string
  goal: string
  result: 'success' | 'partial' | 'failed'
  timestamp: string
}

function storeDir(): string {
  return join(getClaudeConfigHomeDir(), 'evolution')
}

function reflectionsPath(): string {
  return join(storeDir(), 'reflections.json')
}

function reusesPath(): string {
  return join(storeDir(), 'reuses.json')
}

export async function readReflections(): Promise<Reflection[]> {
  try {
    const file = Bun.file(reflectionsPath())
    if (!(await file.exists())) return []
    const parsed = JSON.parse(await file.text()) as { reflections?: Reflection[] }
    return Array.isArray(parsed.reflections) ? parsed.reflections : []
  } catch {
    return []
  }
}

export async function writeReflections(reflections: Reflection[]): Promise<void> {
  await mkdir(storeDir(), { recursive: true })
  await Bun.write(reflectionsPath(), JSON.stringify({ reflections }, null, 2))
}

export async function readReuses(): Promise<ReuseRecord[]> {
  try {
    const file = Bun.file(reusesPath())
    if (!(await file.exists())) return []
    const parsed = JSON.parse(await file.text()) as { reuses?: ReuseRecord[] }
    return Array.isArray(parsed.reuses) ? parsed.reuses : []
  } catch {
    return []
  }
}

export async function writeReuses(reuses: ReuseRecord[]): Promise<void> {
  await mkdir(storeDir(), { recursive: true })
  await Bun.write(reusesPath(), JSON.stringify({ reuses }, null, 2))
}

async function nextId(prefix: string, existing: string[]): Promise<string> {
  const max = existing.reduce((m, s) => {
    const n = parseInt(s.replace(/\D/g, ''), 10)
    return Number.isFinite(n) && n > m ? n : m
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

export async function nextReflectionId(): Promise<string> {
  const rs = await readReflections()
  return nextId('ev', rs.map(r => r.id))
}

export async function nextReuseId(): Promise<string> {
  const us = await readReuses()
  return nextId('ru', us.map(u => u.id))
}

/** Reuse hit-rate ρ = (success + partial) / total reuses. */
export async function hitRate(): Promise<{
  total: number
  success: number
  partial: number
  failed: number
  rho: number | null
}> {
  const us = await readReuses()
  const success = us.filter(u => u.result === 'success').length
  const partial = us.filter(u => u.result === 'partial').length
  const failed = us.filter(u => u.result === 'failed').length
  const total = us.length
  return { total, success, partial, failed, rho: total ? (success + partial) / total : null }
}

/** Tokenize a query into lowercase word/n-gram keys for recall. */
function tokens(text: string): Set<string> {
  const keys = new Set<string>()
  const lower = text.toLowerCase()
  for (const w of lower.split(/[^a-z0-9]+/)) {
    if (w.length >= 2) keys.add(w)
  }
  const cjk = lower.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) keys.add(cjk.slice(i, i + 2))
  for (const ch of cjk) keys.add(ch)
  return keys
}

function score(ref: Reflection, query: string): number {
  const q = tokens(query)
  if (q.size === 0) return 0
  const hay = new Set<string>([
    ...tokens(ref.goal),
    ...ref.tags.flatMap(t => [...tokens(t)]),
    ...ref.lessons.flatMap(l => [...tokens(l.text)]),
  ])
  let hit = 0
  for (const k of q) if (hay.has(k)) hit++
  return hit / q.size
}

/** Recall similar reflections by keyword/tag/lesson overlap, best first. */
export async function recall(query: string, limit = 5): Promise<Reflection[]> {
  const rs = await readReflections()
  return rs
    .map(r => ({ r, s: score(r, query) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.r)
}
