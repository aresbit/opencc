/**
 * Per-machine swarm profile.
 *
 * Everything needed to join a LAN swarm has a working default:
 *   - node: hostname + a persisted random suffix (unique without config)
 *   - DNS: multicast 239.255.77.77:47777, unsigned until a token is set
 *   - capabilities: ["code"], roles: ["generalist"]
 *
 * A profile is only needed when you want to override those defaults. It lives
 * at $CLAUDE_CONFIG_DIR/swarm.json; environment variables win over it so a
 * one-off run can still override a machine's saved choices.
 */

import { readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import memoize from 'lodash-es/memoize.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { AgentStatus } from './dns.js'

export type SwarmProfile = {
  node?: string
  group?: string
  port?: number
  token?: string
  intervalMs?: number
  ttlMs?: number
  pumpIntervalMs?: number
  pruneIntervalMs?: number
  pumpLimit?: number
  capabilities?: string[]
  roles?: string[]
  load?: number
  status?: AgentStatus
  disabled?: boolean
  note?: string
}

export function getSwarmProfilePath(): string {
  return join(getClaudeConfigHomeDir(), 'swarm.json')
}

function strings(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map(item => item.trim())
    .slice(0, max)
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export function normalizeSwarmProfile(raw: unknown): SwarmProfile {
  if (!raw || typeof raw !== 'object') return {}
  const value = raw as Record<string, unknown>
  const status =
    value.status === 'idle' || value.status === 'busy' || value.status === 'offline'
      ? value.status
      : undefined
  return {
    node: typeof value.node === 'string' ? value.node.trim() : undefined,
    group: typeof value.group === 'string' ? value.group.trim() : undefined,
    port: positiveInt(value.port),
    token: typeof value.token === 'string' ? value.token.trim() : undefined,
    intervalMs: positiveInt(value.intervalMs),
    ttlMs: positiveInt(value.ttlMs),
    pumpIntervalMs: positiveInt(value.pumpIntervalMs),
    pruneIntervalMs: positiveInt(value.pruneIntervalMs),
    pumpLimit: positiveInt(value.pumpLimit),
    capabilities: strings(value.capabilities, 32),
    roles: strings(value.roles, 16),
    load:
      typeof value.load === 'number' && value.load >= 0 ? value.load : undefined,
    status,
    disabled: value.disabled === true,
    note: typeof value.note === 'string' ? value.note : undefined,
  }
}

export const loadSwarmProfile = memoize(
  async (): Promise<SwarmProfile> => {
    try {
      return normalizeSwarmProfile(
        jsonParse(await readFile(getSwarmProfilePath(), 'utf8')),
      )
    } catch {
      return {}
    }
  },
  () => getClaudeConfigHomeDir(),
)

/** Sync variant for config readers on startup paths. */
export const loadSwarmProfileSync = memoize(
  (): SwarmProfile => {
    try {
      return normalizeSwarmProfile(
        JSON.parse(readFileSync(getSwarmProfilePath(), 'utf8')),
      )
    } catch {
      return {}
    }
  },
  () => getClaudeConfigHomeDir(),
)

export function reloadSwarmProfileForTesting(): void {
  loadSwarmProfile.cache.clear?.()
  loadSwarmProfileSync.cache.clear?.()
}

/**
 * Create a profile with the defaults spelled out. Never overwrites an existing
 * file: a machine may already carry capabilities/token choices.
 */
export async function writeDefaultSwarmProfile(): Promise<{
  path: string
  created: boolean
  profile: SwarmProfile
}> {
  const path = getSwarmProfilePath()
  const profile: SwarmProfile = {
    capabilities: ['code'],
    roles: ['generalist'],
    note:
      'Optional. Delete a field to use its default. Set the same token on all hosts to sign DNS beacons.',
  }
  try {
    await mkdir(getClaudeConfigHomeDir(), { recursive: true })
    await writeFile(path, jsonStringify(profile, null, 2), {
      flag: 'wx',
    })
    loadSwarmProfile.cache.clear?.()
    return { path, created: true, profile }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return {
      path,
      created: false,
      profile: await loadSwarmProfile(),
    }
  }
}
