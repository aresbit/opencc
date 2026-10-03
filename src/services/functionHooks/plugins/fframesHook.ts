/**
 * fframes — an algebraic-effect plugin for the fframes video tool.
 *
 * Two hooks, and each does more than count:
 *
 *   tool.call  ({ tool_name: 'fframes' })
 *     Classifies the call by `action` and, for render/scaffold, writes a short
 *     note onto the event (`e._fframesEffect`). The note is the effect: a later
 *     observer on the same chain can read it without re-deriving what this
 *     call is about to do.
 *
 *   tool.result ({ tool_name: 'fframes' })
 *     Captures the output path when the result names one, and returns what the
 *     rest of the chain produced *unchanged*. Discarding an inner hook's return
 *     is the classic chain bug (see hookChain.test.ts) — this hook is an
 *     observer and must never eat a decision made below it.
 *
 * A render that produced no file is recorded, not punished: this plugin has no
 * business rolling anything back or synthesizing output it did not see.
 */

import type { OnRegistrar } from '../types.js'

type FramesStats = {
  calls: number
  renders: number
  scaffolds: number
  guides: number
  lastOutput: string | null
  events: number
}

const stats: FramesStats = {
  calls: 0,
  renders: 0,
  scaffolds: 0,
  guides: 0,
  lastOutput: null,
  events: 0,
}

/** Action of the most recent tool.call, so tool.result can interpret a miss. */
let lastCallAction: string | null = null

/** Renders that reported success but named no output file. Recorded, not acted on. */
let unfiledRenders = 0

const MEDIA_PATH =
  /([^\s'"]+\.(?:mp4|mov|webm|mkv|avi|m4v|gif|png|jpe?g|webp|svg|pdf))/i

/**
 * Best-effort: pull an output path out of whatever the result is.
 *
 * FFramesTool.render returns `{ success, action, summary, outputPath, ... }`
 * and scaffold returns `outputDir`; an explicit field is authoritative, so it
 * is returned as-is. Only when no such field exists do we fall back to parsing
 * text — FFramesTool's render summary reads "Rendered <path>: <codec> ...",
 * older tools say "wrote <path>".
 */
function extractOutputPath(value: unknown): string | null {
  let text: string | null = null
  if (typeof value === 'string') {
    text = value
  } else if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const candidate =
      rec.outputPath ?? rec.outputDir ?? rec.videoPath ?? rec.output ??
      rec.path ?? rec.file ?? rec.result
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (typeof rec.summary === 'string') text = rec.summary
  }
  if (!text) return null

  // Capture up to whitespace or a trailing colon (the summary separates the
  // path from the codec with ":") and require the token to look like a path,
  // so a prose "wrote a project into X" does not yield "a".
  const verb = /(?:wrote|rendered|saved)\s+(\S+)/i.exec(text)
  if (verb?.[1]) {
    const token = verb[1].replace(/[:,]+$/, '')
    if (token.includes('/')) return token
  }

  const media = MEDIA_PATH.exec(text)
  if (media?.[1]) return media[1]

  // Last resort: a token that looks like a path (at least one separator).
  const slashed = /([^\s'"]*\/[^\s'"]+)/.exec(text)
  return slashed?.[1] ?? null
}

export function register(on: OnRegistrar): void {
  on('tool.call', { tool_name: 'fframes' }, async ($, e: any, next) => {
    stats.calls++

    const action = e?.tool_input?.action as string | undefined
    lastCallAction = action ?? null

    switch (action) {
      case 'render':
        stats.renders++
        e._fframesEffect = 'fframes: render frames from the project'
        break
      case 'scaffold':
        stats.scaffolds++
        e._fframesEffect = 'fframes: scaffold a new project layout'
        break
      case 'guide':
        stats.guides++
        break
      default:
        break
    }

    return next(e)
  })

  on('tool.result', { tool_name: 'fframes' }, async ($, e: any, next) => {
    stats.events++

    // Never drop what the inner chain returned.
    const out = await next(e)

    const path = extractOutputPath(out) ?? extractOutputPath(e?.result)
    if (path) {
      stats.lastOutput = path
    } else if (lastCallAction === 'render') {
      // A render came back without a named file. Record it and leave every
      // other effect alone — this hook does not retry or fabricate a path.
      unfiledRenders++
    }

    return out
  })
}

export function getFramesStats(): FramesStats {
  return {
    calls: stats.calls,
    renders: stats.renders,
    scaffolds: stats.scaffolds,
    guides: stats.guides,
    lastOutput: stats.lastOutput,
    events: stats.events,
  }
}

export function resetFramesStats(): void {
  stats.calls = 0
  stats.renders = 0
  stats.scaffolds = 0
  stats.guides = 0
  stats.lastOutput = null
  stats.events = 0
  lastCallAction = null
  unfiledRenders = 0
}
