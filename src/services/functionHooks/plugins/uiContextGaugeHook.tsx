/**
 * Context watermark gauge — the flagship "info overlay" UI hook.
 *
 * Wraps the "context-gauge" slot (mounted next to the existing token
 * warning in PromptInput/Notifications.tsx) with a one-line bar: how much
 * of the compaction budget is used, and what the session has cost so far.
 * The call site already computes tokenUsage/threshold via the same
 * calculateTokenWarningState() the built-in TokenWarning uses — this hook
 * renders from that, it does not recompute or poll anything of its own, so
 * there is nothing here that can drift from what the app already believes.
 *
 * Ring placement: outermost UI ring — purely observational. There is no
 * native content for this slot (the call site passes an empty default);
 * this hook is the only thing that ever renders into it.
 */

import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import type { OnRegistrar } from '../types.js'

export interface ContextGaugeProps {
  tokenUsage: number
  threshold: number
  percentLeft: number
  costUSD: number
}

const BAR_WIDTH = 20

function renderBar(usedFraction: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, usedFraction)) * BAR_WIDTH)
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

function colorFor(percentLeft: number): 'error' | 'warning' | 'success' {
  if (percentLeft <= 10) return 'error'
  if (percentLeft <= 25) return 'warning'
  return 'success'
}

export function register(on: OnRegistrar): void {
  on('ui.slot.render', { slotId: 'context-gauge' }, ($, e: any, _next) => {
    const props = e.props as ContextGaugeProps | undefined
    if (!props || typeof props.tokenUsage !== 'number' || props.threshold <= 0) {
      return e.node
    }

    const usedFraction = props.tokenUsage / props.threshold
    const bar = renderBar(usedFraction)
    const color = colorFor(props.percentLeft)
    const usedK = Math.round(props.tokenUsage / 1000)
    const thresholdK = Math.round(props.threshold / 1000)

    return (
      <Text dimColor>
        <Text color={color}>{bar}</Text>
        {` ${usedK}k/${thresholdK}k tokens · ${props.percentLeft}% left · $${props.costUSD.toFixed(2)}`}
      </Text>
    )
  })
}
