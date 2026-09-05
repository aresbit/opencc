/**
 * mount() — MCP Namespace Mounting.
 *
 * Plan 9's "everything mounts into a namespace" applied to agent tool
 * visibility. Each agent gets its own mount table — the set of MCP
 * servers (and their tools) it can see. Admins control agent capability
 * by mounting and unmounting servers, turning the "disallowed tools"
 * deny-list into a "namespace construction" allow-list.
 *
 * mount -t mcp gmail /comms/gmail
 *
 * The mount table is a tree: /comms/gmail/send, /comms/gmail/search.
 * An agent sees only paths in its namespace. The root namespace (/)
 * contains all built-in tools. MCP servers mount under named paths.
 *
 * This replaces capability management by list exclusion with capability
 * management by namespace inclusion — structurally cleaner and easier
 * to audit.
 *
 * Ring placement: ring 1 (manager plugin) — namespace construction is
 * a privileged operation that defines what ring 3 (model) can reach.
 */

import type { OnRegistrar } from '../types.js'

// ── Types ───────────────────────────────────────────────────────

export interface MountPoint {
  /** Where this server is mounted: /comms/gmail, /code/github, etc. */
  path: string
  /** MCP server identifier. */
  serverId: string
  /** Human-readable name. */
  label: string
  /** Tools exposed at this mount point. */
  tools: string[]
  /** Mount options. */
  options: MountOptions
  /** When this was mounted. */
  mountedAt: number
  /** Who mounted it. */
  mountedBy: string
}

export interface MountOptions {
  /** Read-only mount: tools can query but not mutate. */
  readOnly?: boolean
  /** Mask specific tools from this mount. */
  mask?: string[]
  /** Only expose these tools (allowlist, overrides mask). */
  expose?: string[]
  /** Propagate mount to child agents. */
  inherit?: boolean
  /** Auto-unmount after this many milliseconds. */
  ttl?: number
}

export interface Namespace {
  id: string
  label: string
  mounts: Map<string, MountPoint>
  parent?: string
  createdAt: number
}

export interface MountResult {
  path: string
  serverId: string
  toolCount: number
  namespace: string
}

export interface ResolvedTool {
  name: string
  mountPath: string
  serverId: string
  readOnly: boolean
}

// ── State ───────────────────────────────────────────────────────

const namespaces = new Map<string, Namespace>()
const agentNamespaceMap = new Map<string, string>()
let nsCounter = 0

const MAX_NAMESPACES = 50
const MAX_MOUNTS_PER_NS = 30

// Default root namespace
const ROOT_NS_ID = 'ns_root'

function ensureRoot(): Namespace {
  if (!namespaces.has(ROOT_NS_ID)) {
    namespaces.set(ROOT_NS_ID, {
      id: ROOT_NS_ID,
      label: 'root',
      mounts: new Map(),
      createdAt: Date.now(),
    })
  }
  return namespaces.get(ROOT_NS_ID)!
}

// ── Core Operations ─────────────────────────────────────────────

function generateNsId(): string {
  nsCounter++
  return `ns_${nsCounter.toString(16).padStart(4, '0')}`
}

function normalizePath(path: string): string {
  let p = path.startsWith('/') ? path : `/${path}`
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1)
  return p
}

function createNamespace(label: string, parentId?: string): Namespace {
  if (namespaces.size >= MAX_NAMESPACES) {
    throw new Error(`Too many namespaces (max ${MAX_NAMESPACES})`)
  }

  const ns: Namespace = {
    id: generateNsId(),
    label,
    mounts: new Map(),
    parent: parentId,
    createdAt: Date.now(),
  }

  // Inherit mounts from parent
  if (parentId) {
    const parent = namespaces.get(parentId)
    if (parent) {
      for (const [path, mount] of parent.mounts) {
        if (mount.options.inherit !== false) {
          ns.mounts.set(path, { ...mount })
        }
      }
    }
  }

  namespaces.set(ns.id, ns)
  return ns
}

function mountServer(
  nsId: string,
  path: string,
  serverId: string,
  label: string,
  tools: string[],
  options: MountOptions = {},
  mountedBy = 'system',
): MountResult {
  const ns = namespaces.get(nsId) ?? ensureRoot()
  const normalPath = normalizePath(path)

  if (ns.mounts.size >= MAX_MOUNTS_PER_NS) {
    throw new Error(`Too many mounts in namespace "${ns.label}" (max ${MAX_MOUNTS_PER_NS})`)
  }

  // Apply tool filtering
  let visibleTools = [...tools]
  if (options.expose && options.expose.length > 0) {
    visibleTools = visibleTools.filter(t => options.expose!.includes(t))
  } else if (options.mask && options.mask.length > 0) {
    visibleTools = visibleTools.filter(t => !options.mask!.includes(t))
  }

  const mount: MountPoint = {
    path: normalPath,
    serverId,
    label,
    tools: visibleTools,
    options,
    mountedAt: Date.now(),
    mountedBy,
  }

  ns.mounts.set(normalPath, mount)

  // Set up TTL auto-unmount
  if (options.ttl && options.ttl > 0) {
    setTimeout(() => {
      unmountServer(nsId, normalPath)
    }, options.ttl)
  }

  return {
    path: normalPath,
    serverId,
    toolCount: visibleTools.length,
    namespace: ns.id,
  }
}

function unmountServer(nsId: string, path: string): boolean {
  const ns = namespaces.get(nsId)
  if (!ns) return false
  return ns.mounts.delete(normalizePath(path))
}

function resolveTools(nsId: string): ResolvedTool[] {
  const ns = namespaces.get(nsId)
  if (!ns) return []

  const resolved: ResolvedTool[] = []
  for (const [, mount] of ns.mounts) {
    for (const toolName of mount.tools) {
      resolved.push({
        name: toolName,
        mountPath: mount.path,
        serverId: mount.serverId,
        readOnly: mount.options.readOnly ?? false,
      })
    }
  }
  return resolved
}

function isToolVisible(nsId: string, toolName: string): boolean {
  const ns = namespaces.get(nsId)
  if (!ns) return true // No namespace = everything visible

  for (const [, mount] of ns.mounts) {
    if (mount.tools.includes(toolName)) return true
  }
  return false
}

function getAgentNamespace(agentId: string): string {
  return agentNamespaceMap.get(agentId) ?? ROOT_NS_ID
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Intercept tool.call — deny calls to tools not in the agent's namespace
  on('tool.call', async ($, e: any, next) => {
    const agentId = e.agent_id as string | undefined
    if (!agentId) return next(e) // No agent context = root namespace

    const nsId = getAgentNamespace(agentId)
    if (nsId === ROOT_NS_ID) return next(e) // Root sees everything

    const toolName = (e.tool_name ?? e.tool) as string
    if (!isToolVisible(nsId, toolName)) {
      return {
        deny: `Tool "${toolName}" is not mounted in agent namespace "${nsId}". ` +
              `Use $.mount.list() to see available tools.`,
      }
    }

    // Check read-only mounts
    const ns = namespaces.get(nsId)
    if (ns) {
      for (const [, mount] of ns.mounts) {
        if (mount.tools.includes(toolName) && mount.options.readOnly) {
          const writingTools = ['Write', 'Edit', 'NotebookEdit', 'Bash']
          if (writingTools.includes(toolName)) {
            return {
              deny: `Tool "${toolName}" is mounted read-only at "${mount.path}".`,
            }
          }
        }
      }
    }

    return next(e)
  })

  // When a subagent spawns, create a child namespace
  on('subagent.start', async ($, e: any, next) => {
    const agentId = e.agent_id as string | undefined
    // SubagentStartHookInput carries only the new subagent's own agent_id —
    // there is no parent-agent-id field in the hookInput shape, so a nested
    // subagent's namespace always inherits from root rather than its
    // spawning agent's namespace. (parentAgentId was previously read from a
    // field that never existed either, so this is not a behavior change —
    // just made explicit instead of silently reading undefined.)
    if (agentId) {
      const parentNsId = ROOT_NS_ID

      try {
        const childNs = createNamespace(`agent:${agentId}`, parentNsId)
        agentNamespaceMap.set(agentId, childNs.id)
      } catch { /* fail-open: agent uses root */ }
    }

    return next(e)
  })

  // When a subagent stops, clean up its namespace
  on('subagent.stop', async ($, e: any, next) => {
    const result = await next(e)

    const agentId = e.agent_id as string | undefined
    if (agentId) {
      const nsId = agentNamespaceMap.get(agentId)
      if (nsId && nsId !== ROOT_NS_ID) {
        namespaces.delete(nsId)
        agentNamespaceMap.delete(agentId)
      }
    }

    return result
  })
}

// ── Public API ──────────────────────────────────────────────────

export function mount(
  path: string,
  serverId: string,
  label: string,
  tools: string[],
  options?: MountOptions,
  nsId?: string,
): MountResult {
  return mountServer(nsId ?? ROOT_NS_ID, path, serverId, label, tools, options)
}

export function umount(path: string, nsId?: string): boolean {
  return unmountServer(nsId ?? ROOT_NS_ID, path)
}

export function createNs(label: string, parentId?: string): Namespace {
  return createNamespace(label, parentId)
}

export function destroyNs(nsId: string): boolean {
  if (nsId === ROOT_NS_ID) return false
  // Clean up agent mappings pointing to this namespace
  for (const [agentId, ns] of agentNamespaceMap) {
    if (ns === nsId) agentNamespaceMap.delete(agentId)
  }
  return namespaces.delete(nsId)
}

export function bindAgent(agentId: string, nsId: string): void {
  if (!namespaces.has(nsId)) {
    throw new Error(`Namespace "${nsId}" not found`)
  }
  agentNamespaceMap.set(agentId, nsId)
}

export function unbindAgent(agentId: string): void {
  agentNamespaceMap.delete(agentId)
}

export function resolve(nsId?: string): ResolvedTool[] {
  return resolveTools(nsId ?? ROOT_NS_ID)
}

export function listMounts(nsId?: string): MountPoint[] {
  const ns = namespaces.get(nsId ?? ROOT_NS_ID)
  return ns ? [...ns.mounts.values()] : []
}

export function listNamespaces(): Array<{
  id: string
  label: string
  mountCount: number
  parent?: string
  agentCount: number
}> {
  return [...namespaces.values()].map(ns => ({
    id: ns.id,
    label: ns.label,
    mountCount: ns.mounts.size,
    parent: ns.parent,
    agentCount: [...agentNamespaceMap.values()].filter(n => n === ns.id).length,
  }))
}

export function getStats(): {
  namespaces: number
  totalMounts: number
  boundAgents: number
} {
  let totalMounts = 0
  for (const ns of namespaces.values()) {
    totalMounts += ns.mounts.size
  }
  return {
    namespaces: namespaces.size,
    totalMounts,
    boundAgents: agentNamespaceMap.size,
  }
}

export function clearMounts(): void {
  namespaces.clear()
  agentNamespaceMap.clear()
  nsCounter = 0
  ensureRoot()
}
