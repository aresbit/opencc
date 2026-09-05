/**
 * RSI heartbeat — the "zenith" UI hooks: the self-improvement loop becomes
 * visible instead of a black box.
 *
 * Listens to rsi.antibody.block (an antibody guard just stopped a known-bad
 * pattern) and rsi.crystal.crystallize (a repeated tool sequence just
 * compiled into a reusable skill) and surfaces both: a one-shot toast
 * through the real in-TUI notification queue, and a persistent status-bar
 * icon for crystallization. Both events were previously declared in the
 * FunctionHookEvent union but never actually dispatched anywhere — this
 * hook is only meaningful because rsiAntibodyHook.ts / rsiCrystallizeHook.ts
 * were given real dispatchBestEffort() calls at their block/crystallize
 * sites alongside this plugin.
 */

import * as React from 'react'
import { Text } from '../../../ink.js'
import type { OnRegistrar } from '../types.js'
import { requestToast, bumpUIEpoch } from '../uiDispatcher.js'

let crystalCount = 0
let lastAntibodyBlock: { tool: string; message: string; at: number } | null = null

export function register(on: OnRegistrar): void {
  on('rsi.antibody.block', ($, e: any, next) => {
    lastAntibodyBlock = { tool: e.tool, message: e.message, at: Date.now() }
    requestToast({
      key: `antibody-block-${e.tool}`,
      text: `已为你挡下 ${e.tool} 的已知失败模式 (第 ${e.blockCount} 次)`,
      color: 'warning',
      priority: 'low',
      timeoutMs: 5000,
    })
    return next(e)
  })

  on('rsi.crystal.crystallize', ($, e: any, next) => {
    crystalCount++
    bumpUIEpoch()
    requestToast({
      key: `crystallize-${e.name}`,
      text: `已将 ${e.steps} 步操作结晶为技能 "${e.name}" (成功率 ${Math.round(e.successRate * 100)}%)`,
      color: 'success',
      priority: 'low',
      timeoutMs: 6000,
    })
    return next(e)
  })

  on('ui.slot.render', { slotId: 'rsi-heartbeat' }, ($, e: any, _next) => {
    if (crystalCount === 0) return e.node
    return <Text dimColor>{`💎×${crystalCount}`}</Text>
  })
}

export function getCrystalCount(): number {
  return crystalCount
}

export function getLastAntibodyBlock(): { tool: string; message: string; at: number } | null {
  return lastAntibodyBlock
}

export function clearRsiHeartbeat(): void {
  crystalCount = 0
  lastAntibodyBlock = null
}
