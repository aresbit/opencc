import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getCurrentActorAddress } from '../actor/currentActor.js'
import { parseActorAddress } from '../actor/types.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { sanitizePathComponent } from '../utils/tasks.js'
import {
  DEFAULT_POLICY,
  MAX_EPISODES,
  makeDefaultState,
  type SwarmEdge,
  type SwarmEpisode,
  type SwarmState,
} from './types.js'

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}

export function getSwarmRoot(): string {
  return join(getClaudeConfigHomeDir(), 'swarm-net')
}

export function statePathFor(team: string): string {
  return join(getSwarmRoot(), sanitizePathComponent(team) || 'default', 'state.json')
}

/** Team name from the current actor address, so routing state is per team. */
export function getSwarmTeam(): string {
  try {
    return parseActorAddress(getCurrentActorAddress()).team
  } catch {
    return process.env.CLAUDE_CODE_TEAM_NAME?.trim() || 'default'
  }
}

function normalizeEdge(raw: unknown): SwarmEdge | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<SwarmEdge>
  if (typeof value.from !== 'string' || typeof value.to !== 'string') return null
  return {
    from: value.from,
    to: value.to,
    alpha: Number.isFinite(value.alpha) ? Number(value.alpha) : 1,
    beta: Number.isFinite(value.beta) ? Number(value.beta) : 1,
    attempts: Number.isFinite(value.attempts) ? Number(value.attempts) : 0,
    latencyEmaMs: Number.isFinite(value.latencyEmaMs)
      ? Number(value.latencyEmaMs)
      : 500,
    costEma: Number.isFinite(value.costEma) ? Number(value.costEma) : 0,
    pheromone: Number.isFinite(value.pheromone) ? Number(value.pheromone) : 0,
    lastUsedAt: typeof value.lastUsedAt === 'string' ? value.lastUsedAt : undefined,
  }
}

function normalizeEpisode(raw: unknown): SwarmEpisode | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<SwarmEpisode>
  if (
    typeof value.id !== 'string' ||
    typeof value.src !== 'string' ||
    typeof value.dst !== 'string' ||
    !Array.isArray(value.path) ||
    value.path.some(item => typeof item !== 'string')
  ) {
    return null
  }
  return {
    id: value.id,
    src: value.src,
    dst: value.dst,
    path: value.path as string[],
    success: value.success === true,
    reward: Number.isFinite(value.reward) ? Number(value.reward) : 0,
    latencyMs: Number.isFinite(value.latencyMs) ? Number(value.latencyMs) : 0,
    hopLatencyMs: Array.isArray(value.hopLatencyMs)
      ? value.hopLatencyMs.filter(item => Number.isFinite(item)).map(Number)
      : [],
    observed: value.observed === true,
    at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
  }
}

export function normalizeState(raw: unknown, team: string): SwarmState {
  const base = makeDefaultState(team)
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Partial<SwarmState>
  const edges: Record<string, SwarmEdge> = {}
  if (value.edges && typeof value.edges === 'object') {
    for (const entry of Object.values(value.edges)) {
      const edge = normalizeEdge(entry)
      if (edge) edges[`${edge.from}\u0000${edge.to}`] = edge
    }
  }
  const episodes = Array.isArray(value.episodes)
    ? value.episodes
        .map(normalizeEpisode)
        .filter((episode): episode is SwarmEpisode => episode !== null)
        .slice(-MAX_EPISODES)
    : []
  const policy = { ...DEFAULT_POLICY, ...(value.policy ?? {}) }
  return {
    ...base,
    edges,
    episodes,
    policy,
    bestMetric: value.bestMetric,
    updatedAt:
      typeof value.updatedAt === 'string' ? value.updatedAt : base.updatedAt,
  }
}

async function ensureStateFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, jsonStringify(makeDefaultState('default'), null, 2), {
      flag: 'wx',
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export async function loadState(team = getSwarmTeam()): Promise<SwarmState> {
  const path = statePathFor(team)
  try {
    return normalizeState(jsonParse(await readFile(path, 'utf8')), team)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return makeDefaultState(team)
    }
    throw error
  }
}

export async function saveState(state: SwarmState): Promise<void> {
  const path = statePathFor(state.team)
  await mkdir(dirname(path), { recursive: true })
  state.updatedAt = new Date().toISOString()
  await writeFile(path, jsonStringify(state, null, 2), 'utf8')
}

/**
 * Read-modify-write under a file lock. Relay and learning can run from several
 * sessions on one machine; without the lock the last writer silently drops the
 * other's pheromone deposits, which is exactly the signal this layer learns
 * from.
 */
export async function withState<T>(
  team: string,
  change: (state: SwarmState) => T | Promise<T>,
): Promise<T> {
  const path = statePathFor(team)
  await ensureStateFile(path)
  const release = await lockfile.lock(path, LOCK_OPTIONS)
  try {
    const state = normalizeState(jsonParse(await readFile(path, 'utf8')), team)
    const result = await change(state)
    await saveState(state)
    return result
  } finally {
    await release()
  }
}
