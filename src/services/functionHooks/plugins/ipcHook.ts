/**
 * IPC — Inter-Process Communication for Agents.
 *
 * Two primitives the agent OS is missing:
 *
 * 1. msg.send/recv — Cross-session mailbox. Agents in different sessions
 *    can exchange messages through named channels. This is the socket/
 *    mqueue equivalent: multi-agent collaboration without human relay.
 *
 * 2. flock — Advisory file locks. Prevents two sessions from editing the
 *    same file simultaneously. The lock is advisory (cooperative), not
 *    mandatory — same as POSIX flock(). Turns "two sessions force-pushing
 *    over each other" from prayer into protocol.
 *
 * Ring placement: ring 1 (manager plugin) — IPC and locks are privileged
 * operations that affect shared state across execution contexts.
 */

import type { OnRegistrar } from '../types.js'

// ═══════════════════════════════════════════════════════════════
// Part 1: Message Passing (msg.send / msg.recv)
// ═══════════════════════════════════════════════════════════════

export interface Message {
  id: string
  channel: string
  from: string
  to?: string
  body: unknown
  sentAt: number
  read: boolean
  ttl: number
}

interface Channel {
  name: string
  messages: Message[]
  subscribers: Set<string>
  createdAt: number
}

const channels = new Map<string, Channel>()
let msgCounter = 0

const MAX_CHANNELS = 50
const MAX_MESSAGES_PER_CHANNEL = 200
const DEFAULT_MSG_TTL = 3_600_000 // 1 hour

function generateMsgId(): string {
  msgCounter++
  return `msg_${msgCounter.toString(16).padStart(6, '0')}`
}

function getOrCreateChannel(name: string): Channel {
  let ch = channels.get(name)
  if (!ch) {
    if (channels.size >= MAX_CHANNELS) {
      // Evict oldest channel
      let oldestKey: string | undefined
      let oldestTime = Infinity
      for (const [key, chan] of channels) {
        if (chan.createdAt < oldestTime) {
          oldestTime = chan.createdAt
          oldestKey = key
        }
      }
      if (oldestKey) channels.delete(oldestKey)
    }

    ch = {
      name,
      messages: [],
      subscribers: new Set(),
      createdAt: Date.now(),
    }
    channels.set(name, ch)
  }
  return ch
}

function sendMessage(
  channel: string,
  from: string,
  body: unknown,
  to?: string,
  ttl?: number,
): Message {
  const ch = getOrCreateChannel(channel)
  const msg: Message = {
    id: generateMsgId(),
    channel,
    from,
    to,
    body,
    sentAt: Date.now(),
    read: false,
    ttl: ttl ?? DEFAULT_MSG_TTL,
  }

  ch.messages.push(msg)

  // Enforce per-channel limit
  if (ch.messages.length > MAX_MESSAGES_PER_CHANNEL) {
    ch.messages.shift()
  }

  return msg
}

function recvMessages(
  channel: string,
  recipientId: string,
  limit = 10,
  markRead = true,
): Message[] {
  const ch = channels.get(channel)
  if (!ch) return []

  const now = Date.now()
  const matching = ch.messages.filter(m => {
    if (now - m.sentAt > m.ttl) return false // expired
    if (m.read) return false
    if (m.to && m.to !== recipientId) return false
    return true
  })

  const result = matching.slice(0, limit)
  if (markRead) {
    for (const msg of result) msg.read = true
  }
  return result
}

function subscribe(channel: string, subscriberId: string): void {
  getOrCreateChannel(channel).subscribers.add(subscriberId)
}

function unsubscribe(channel: string, subscriberId: string): void {
  channels.get(channel)?.subscribers.delete(subscriberId)
}

// Garbage-collect expired messages
function gcMessages(): number {
  const now = Date.now()
  let removed = 0
  for (const ch of channels.values()) {
    const before = ch.messages.length
    ch.messages = ch.messages.filter(m => now - m.sentAt <= m.ttl)
    removed += before - ch.messages.length
  }
  return removed
}

// ═══════════════════════════════════════════════════════════════
// Part 2: Advisory File Locks (flock)
// ═══════════════════════════════════════════════════════════════

export type LockType = 'shared' | 'exclusive'

export interface FileLock {
  path: string
  type: LockType
  holder: string
  acquiredAt: number
  /** Auto-release after this many ms. 0 = manual release only. */
  ttl: number
}

const locks = new Map<string, FileLock[]>()
const MAX_LOCKS = 200
const DEFAULT_LOCK_TTL = 300_000 // 5 minutes

function normalizePath(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '')
}

function acquireLock(
  path: string,
  holder: string,
  type: LockType = 'exclusive',
  ttl?: number,
): FileLock | { blocked: true; holders: string[] } {
  const npath = normalizePath(path)
  const existing = getActiveLocks(npath)

  // Check compatibility
  if (type === 'exclusive' && existing.length > 0) {
    return { blocked: true, holders: existing.map(l => l.holder) }
  }

  if (type === 'shared') {
    const exclusiveHolders = existing.filter(l => l.type === 'exclusive')
    if (exclusiveHolders.length > 0) {
      return { blocked: true, holders: exclusiveHolders.map(l => l.holder) }
    }
  }

  // Total lock count check
  let totalLocks = 0
  for (const lockList of locks.values()) totalLocks += lockList.length
  if (totalLocks >= MAX_LOCKS) {
    gcLocks()
    totalLocks = 0
    for (const lockList of locks.values()) totalLocks += lockList.length
    if (totalLocks >= MAX_LOCKS) {
      throw new Error(`Too many locks (max ${MAX_LOCKS})`)
    }
  }

  const lock: FileLock = {
    path: npath,
    type,
    holder,
    acquiredAt: Date.now(),
    ttl: ttl ?? DEFAULT_LOCK_TTL,
  }

  const pathLocks = locks.get(npath) ?? []
  pathLocks.push(lock)
  locks.set(npath, pathLocks)

  // Auto-release on TTL
  if (lock.ttl > 0) {
    setTimeout(() => releaseLock(npath, holder), lock.ttl)
  }

  return lock
}

function releaseLock(path: string, holder: string): boolean {
  const npath = normalizePath(path)
  const pathLocks = locks.get(npath)
  if (!pathLocks) return false

  const idx = pathLocks.findIndex(l => l.holder === holder)
  if (idx === -1) return false

  pathLocks.splice(idx, 1)
  if (pathLocks.length === 0) locks.delete(npath)
  return true
}

function getActiveLocks(path: string): FileLock[] {
  const npath = normalizePath(path)
  const pathLocks = locks.get(npath) ?? []
  const now = Date.now()
  return pathLocks.filter(l => l.ttl === 0 || now - l.acquiredAt < l.ttl)
}

function releaseAllForHolder(holder: string): number {
  let released = 0
  for (const [path, pathLocks] of locks) {
    const before = pathLocks.length
    const remaining = pathLocks.filter(l => l.holder !== holder)
    if (remaining.length < before) {
      released += before - remaining.length
      if (remaining.length === 0) locks.delete(path)
      else locks.set(path, remaining)
    }
  }
  return released
}

function gcLocks(): number {
  const now = Date.now()
  let removed = 0
  for (const [path, pathLocks] of locks) {
    const before = pathLocks.length
    const active = pathLocks.filter(l => l.ttl === 0 || now - l.acquiredAt < l.ttl)
    removed += before - active.length
    if (active.length === 0) locks.delete(path)
    else locks.set(path, active)
  }
  return removed
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  // Check locks on file writes
  on('tool.call', { tool_name: 'Write' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    const agentId = (e._agentId ?? 'main') as string

    if (filePath) {
      const activeLocks = getActiveLocks(filePath)
      const blocked = activeLocks.filter(
        l => l.type === 'exclusive' && l.holder !== agentId,
      )
      if (blocked.length > 0) {
        return {
          deny: `File "${filePath}" is locked by ${blocked.map(l => l.holder).join(', ')}. ` +
                `Wait or use $.ipc.releaseLock() to request release.`,
        }
      }
    }

    return next(e)
  })

  on('tool.call', { tool_name: 'Edit' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    const agentId = (e._agentId ?? 'main') as string

    if (filePath) {
      const activeLocks = getActiveLocks(filePath)
      const blocked = activeLocks.filter(
        l => l.type === 'exclusive' && l.holder !== agentId,
      )
      if (blocked.length > 0) {
        return {
          deny: `File "${filePath}" is locked by ${blocked.map(l => l.holder).join(', ')}. ` +
                `Wait or use $.ipc.releaseLock() to request release.`,
        }
      }
    }

    return next(e)
  })

  // Clean up locks when a session ends
  on('session.end', async ($, e: any, next) => {
    const sessionId = e.sessionId as string | undefined
    if (sessionId) {
      releaseAllForHolder(sessionId)
    }
    gcMessages()
    return next(e)
  })
}

// ── Public API ──────────────────────────────────────────────────

// Message passing
export { sendMessage as send }
export { recvMessages as recv }
export { subscribe, unsubscribe }

export function listChannels(): Array<{
  name: string
  messageCount: number
  subscriberCount: number
  age: number
}> {
  const now = Date.now()
  return [...channels.values()].map(ch => ({
    name: ch.name,
    messageCount: ch.messages.length,
    subscriberCount: ch.subscribers.size,
    age: now - ch.createdAt,
  }))
}

export function peekChannel(channel: string, limit = 5): Message[] {
  const ch = channels.get(channel)
  if (!ch) return []
  return ch.messages.slice(-limit)
}

// File locks
export { acquireLock as flock }
export { releaseLock as funlock }
export { releaseAllForHolder as releaseAll }

export function listLocks(): Array<{
  path: string
  type: LockType
  holder: string
  age: number
}> {
  const now = Date.now()
  const result: Array<{ path: string; type: LockType; holder: string; age: number }> = []
  for (const pathLocks of locks.values()) {
    for (const lock of pathLocks) {
      if (lock.ttl === 0 || now - lock.acquiredAt < lock.ttl) {
        result.push({
          path: lock.path,
          type: lock.type,
          holder: lock.holder,
          age: now - lock.acquiredAt,
        })
      }
    }
  }
  return result
}

export function isLocked(path: string): boolean {
  return getActiveLocks(path).length > 0
}

export function getStats(): {
  channels: number
  totalMessages: number
  locks: number
  subscribers: number
} {
  let totalMessages = 0
  let subscribers = 0
  for (const ch of channels.values()) {
    totalMessages += ch.messages.length
    subscribers += ch.subscribers.size
  }
  let lockCount = 0
  for (const pathLocks of locks.values()) lockCount += pathLocks.length
  return { channels: channels.size, totalMessages, locks: lockCount, subscribers }
}

export function clearIpc(): void {
  channels.clear()
  locks.clear()
  msgCounter = 0
}
