/**
 * git/env status bar — an info-overlay UI hook.
 *
 * Renders branch, uncommitted-file count, and running-background-task
 * count directly to the TUI instead of folding them into the system
 * prompt's additionalContext (the existing getGitStatus() in context.ts is
 * a one-shot memoized snapshot taken for the model, explicitly not meant to
 * update — wrong tool for a live bar). This plugin owns its own poll loop
 * over the real git.ts utilities and caches the result, since git status
 * is inherently async and a ui.slot.render hook must return synchronously.
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import type { OnRegistrar } from '../types.js'
import { getBranch, getIsClean, getChangedFiles } from '../../../utils/git.js'
import { bumpUIEpoch } from '../uiDispatcher.js'

interface CachedGitStatus {
  branch: string | null
  uncommittedCount: number
  isClean: boolean
  lastPolledAt: number
  error: boolean
}

const POLL_INTERVAL_MS = 4000

let cached: CachedGitStatus = {
  branch: null,
  uncommittedCount: 0,
  isClean: true,
  lastPolledAt: 0,
  error: false,
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let polling = false

async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const [branch, isClean, changed] = await Promise.all([
      getBranch(),
      getIsClean(),
      getChangedFiles(),
    ])
    const next: CachedGitStatus = {
      branch,
      isClean,
      uncommittedCount: changed.length,
      lastPolledAt: Date.now(),
      error: false,
    }
    const changedFromCache =
      next.branch !== cached.branch ||
      next.isClean !== cached.isClean ||
      next.uncommittedCount !== cached.uncommittedCount
    cached = next
    if (changedFromCache) bumpUIEpoch()
  } catch {
    cached = { ...cached, error: true }
  } finally {
    polling = false
  }
}

function startPolling(): void {
  if (pollTimer) return
  void pollOnce()
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS)
  pollTimer.unref?.()
}

export interface GitStatusProps {
  backgroundTaskCount?: number
}

export function register(on: OnRegistrar): void {
  startPolling()

  on('ui.slot.render', { slotId: 'git-status' }, ($, e: any, _next) => {
    if (!cached.branch) return e.node

    const props = e.props as GitStatusProps | undefined
    const parts: string[] = [cached.branch]
    if (!cached.isClean) parts.push(`${cached.uncommittedCount} uncommitted`)
    if (props?.backgroundTaskCount) parts.push(`${props.backgroundTaskCount} background`)

    return (
      <Text dimColor>
        {parts.join(' · ')}
      </Text>
    )
  })
}

export function getCachedGitStatus(): CachedGitStatus {
  return cached
}

export function clearUiGitStatus(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  cached = { branch: null, uncommittedCount: 0, isClean: true, lastPolledAt: 0, error: false }
}
