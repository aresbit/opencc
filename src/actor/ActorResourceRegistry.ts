import { randomUUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'

export type ActorResource = {
  id: string
  owner: string
  capacity: number
  metadata?: Record<string, unknown>
  updatedAt: string
}

export type ActorResourceLease = {
  id: string
  resourceId: string
  holder: string
  units: number
  note?: string
  acquiredAt: string
  expiresAt: string
}

export type ActorResourceSnapshot = ActorResource & {
  used: number
  available: number
  leases: ActorResourceLease[]
}

type RegistryState = {
  resources: ActorResource[]
  leases: ActorResourceLease[]
}

const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
  stale: 30_000,
}

function validateId(value: string, label: string): string {
  const id = value.trim()
  if (!id || id.length > 128) {
    throw new Error(`${label} must be 1-128 characters`)
  }
  return id
}

function cleanExpired(state: RegistryState, now = Date.now()): boolean {
  const before = state.leases.length
  state.leases = state.leases.filter(
    lease => Date.parse(lease.expiresAt) > now,
  )
  return state.leases.length !== before
}

/**
 * Cross-directory resource leases backed by the same config root as Actor
 * mailboxes. The file lock makes an acquire atomic across OpenCC processes.
 */
export class ActorResourceRegistry {
  readonly path: string

  constructor(root = join(getClaudeConfigHomeDir(), 'actors')) {
    this.path = join(root, 'resources.json')
  }

  private async ensure(): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true })
    try {
      await writeFile(this.path, '{"resources":[],"leases":[]}', {
        flag: 'wx',
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  private async read(): Promise<RegistryState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<RegistryState>
      return {
        resources: Array.isArray(parsed.resources) ? parsed.resources : [],
        leases: Array.isArray(parsed.leases) ? parsed.leases : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { resources: [], leases: [] }
      }
      throw error
    }
  }

  private async exclusive<T>(operation: (state: RegistryState) => T): Promise<T> {
    await this.ensure()
    const release = await lockfile.lock(this.path, LOCK_OPTIONS)
    try {
      const state = await this.read()
      cleanExpired(state)
      const result = operation(state)
      await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      return result
    } finally {
      await release()
    }
  }

  async publish(input: {
    id: string
    owner: string
    capacity?: number
    metadata?: Record<string, unknown>
  }): Promise<ActorResourceSnapshot> {
    const id = validateId(input.id, 'resource id')
    const capacity = input.capacity ?? 1
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
      throw new Error('resource capacity must be an integer between 1 and 1000000')
    }
    return this.exclusive(state => {
      const existing = state.resources.find(resource => resource.id === id)
      if (existing && existing.owner !== input.owner) {
        throw new Error(
          `resource ${id} is owned by ${existing.owner}; only its owner can republish it`,
        )
      }
      const resource: ActorResource = {
        id,
        owner: input.owner,
        capacity,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        updatedAt: new Date().toISOString(),
      }
      state.resources = [
        ...state.resources.filter(item => item.id !== id),
        resource,
      ]
      return this.snapshot(resource, state.leases)
    })
  }

  async list(): Promise<ActorResourceSnapshot[]> {
    return this.exclusive(state =>
      state.resources
        .map(resource => this.snapshot(resource, state.leases))
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
  }

  async acquire(input: {
    resourceId: string
    holder: string
    units?: number
    ttlMs?: number
    note?: string
  }): Promise<{ resource: ActorResourceSnapshot; lease: ActorResourceLease }> {
    const resourceId = validateId(input.resourceId, 'resource id')
    const units = input.units ?? 1
    if (!Number.isInteger(units) || units < 1) {
      throw new Error('resource units must be a positive integer')
    }
    const ttlMs = input.ttlMs ?? 15 * 60 * 1000
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new Error('resource ttl_ms must be between 1000 and 86400000')
    }
    return this.exclusive(state => {
      const resource = state.resources.find(item => item.id === resourceId)
      if (!resource) throw new Error(`unknown resource: ${resourceId}`)
      const snapshot = this.snapshot(resource, state.leases)
      if (snapshot.available < units) {
        const holders = snapshot.leases
          .map(lease => `${lease.holder}:${lease.units}`)
          .join(', ')
        throw new Error(
          `resource ${resourceId} has ${snapshot.available}/${snapshot.capacity} units available; requested ${units}` +
            (holders ? ` (active leases: ${holders})` : ''),
        )
      }
      const now = Date.now()
      const lease: ActorResourceLease = {
        id: `lease-${randomUUID()}`,
        resourceId,
        holder: input.holder,
        units,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      }
      state.leases.push(lease)
      return { resource: this.snapshot(resource, state.leases), lease }
    })
  }

  async release(input: {
    leaseId: string
    actor: string
  }): Promise<{ lease: ActorResourceLease; resource: ActorResource }> {
    const leaseId = validateId(input.leaseId, 'lease id')
    return this.exclusive(state => {
      const lease = state.leases.find(item => item.id === leaseId)
      if (!lease) throw new Error(`unknown or expired resource lease: ${leaseId}`)
      const resource = state.resources.find(item => item.id === lease.resourceId)
      if (lease.holder !== input.actor && resource?.owner !== input.actor) {
        throw new Error(
          `lease ${leaseId} belongs to ${lease.holder}; only the holder or resource owner can release it`,
        )
      }
      state.leases = state.leases.filter(item => item.id !== leaseId)
      if (!resource) throw new Error(`resource no longer exists: ${lease.resourceId}`)
      return { lease, resource }
    })
  }

  private snapshot(
    resource: ActorResource,
    leases: ActorResourceLease[],
  ): ActorResourceSnapshot {
    const active = leases.filter(lease => lease.resourceId === resource.id)
    const used = active.reduce((sum, lease) => sum + lease.units, 0)
    return {
      ...resource,
      used,
      available: Math.max(0, resource.capacity - used),
      leases: active,
    }
  }
}
