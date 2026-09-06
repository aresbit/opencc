/**
 * Context shunt — the payload never enters the expensive model's context.
 *
 * Modeled on Spotify's Portal/"shunt" result (~90% token reduction), but
 * built as a real algebraic-effect handler rather than the block-and-bounce
 * approximation a conventional hook system forces.
 *
 * What actually produces the saving (worth being precise about, because it
 * is easy to attribute it to the wrong thing): it is NOT "route work to a
 * cheaper model". It is that context bytes are a COMPOUNDING cost — a
 * 3000-line file read into the transcript is not billed once, it is
 * re-sent and re-cached on every subsequent turn of the session. Removing
 * it removes a per-turn tax, which is the only way a 90%-scale number is
 * reachable at all. The cheap model is just the mechanism that lets you
 * drop the bytes without dropping the information.
 *
 * The handler shape:
 *
 *   ctl tool.content(text)
 *     if bytes(text) > threshold
 *     then resume( summarize-with-cheap-model(text) + deref-token )
 *     else resume( text )
 *
 * The `resume` value is what the continuation (the expensive model) sees.
 * Portal's plugin cannot do this — a PreToolUse hook can only allow/deny, so
 * it has to block the Read and bounce the model into a skill. Here the read
 * happens, the full text goes to a Haiku worker, and only the summary comes
 * back up the chain. Nested handler, minimized resume value.
 *
 * Two design consequences worth stating:
 *
 * 1. Intercept the OUTPUT, not the input. Portal's `check-bash-read` has to
 *    regex-match `cat`/`head`/`tail` and special-case `cat f | grep` to
 *    guess, before running, whether a command will emit a lot. That is
 *    forced by allow/deny-only hooks: once the bytes exist it is too late.
 *    With a transformable resume you let the command run and narrow the
 *    RESULT — zero shell parsing, nothing slips through, and it covers
 *    Bash/Grep/MCP output identically. (This session measured the input-side
 *    concern separately and found pipeline-stage cost immaterial: a
 *    single command, a 2-stage pipeline and a 4-stage pipeline all measured
 *    the same, so there was nothing there to rewrite for.)
 *
 * 2. Summary AND exact bytes, not summary alone. Portal reports it cannot
 *    delegate edits, because worker summaries lack reliable line numbers, so
 *    the main model has to re-read anyway. This hook composes with
 *    contextHandleHook: the full text is already in the handle store, so the
 *    summary ships with a `deref(handle, start, end)` token. Orientation is
 *    lossy and cheap; editing pulls exact bytes on demand. That is the
 *    "骨架视图 + 惰性重读凭证" shape, and it falls out of the data flow rather
 *    than needing another special case.
 *
 * Position: registered immediately OUTSIDE contextHandle, so `await next(e)`
 * returns contextHandle's `[handle:res_xxxx] … preview` output. This hook
 * then upgrades the mechanical first-50-lines preview into a semantic
 * summary, reusing the store contextHandle already populated. Nothing is
 * duplicated.
 *
 * ON by default, deliberately, and it is the only transform in this chain
 * that makes a network call — every other one is cheap and deterministic.
 * What that buys and costs, stated plainly so the tradeoff is visible at the
 * point of decision:
 *
 *   + a large tool result stops entering context, and since context bytes
 *     are re-sent every turn, that saving compounds for the rest of the
 *     session
 *   - one worker round-trip (up to timeoutMs) per distinct large result,
 *     charged in worker tokens
 *   - the summary is lossy where the preview it replaces was exact bytes;
 *     exact bytes remain available through deref(handle, start, end)
 *
 * Turn it off with setShuntConfig({ enabled: false }) or $.shunt.disable().
 * getShuntStats() is how to tell whether it is actually working: a session
 * with summarized === 0 and failures > 0 means the worker is unreachable and
 * every result quietly fell back to contextHandle's preview.
 *
 * Fail-open at every step: disabled, no handle, worker error, timeout, empty
 * response — all return contextHandle's output unchanged, which is exactly
 * the behavior that existed before this hook.
 */

import type { OnRegistrar } from '../types.js'
import { peekHandle } from './contextHandleHook.js'
import { queryHaiku } from '../../api/claude.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'

export interface ShuntConfig {
  /** On. Disable with setShuntConfig({ enabled: false }) or $.shunt.disable(). */
  enabled: boolean
  /**
   * Only summarize content at least this large (chars).
   *
   * The effective threshold is max(minChars, contextHandle's threshold):
   * this hook only ever sees results contextHandle already turned into a
   * handle, so a value below that one raises nothing. Use
   * setHandleThreshold() to move the floor.
   */
  minChars: number
  /** Restrict to these tool names; null means every tool. */
  tools: string[] | null
  /** Give up on the worker after this long and keep the preview. */
  timeoutMs: number
  /** Never send more than this much text to the worker. */
  maxInputChars: number
  /**
   * Ceiling on simultaneous worker calls.
   *
   * StreamingToolExecutor runs concurrency-safe tools in parallel, so
   * several large results can land at once and each one wants a summary.
   * Unbounded, that is N simultaneous requests to the worker model —
   * measured at 25 in a concurrency test, which is a rate-limit and cost
   * spike, and slower per call besides since they contend. Excess calls
   * queue rather than being dropped: a summary deferred is still a summary,
   * whereas skipping one silently falls back to the preview.
   */
  maxConcurrentWorkers: number
}

const DEFAULT_CONFIG: ShuntConfig = {
  enabled: true,
  minChars: 16384,
  tools: null,
  timeoutMs: 15_000,
  maxInputChars: 200_000,
  maxConcurrentWorkers: 4,
}

let config: ShuntConfig = { ...DEFAULT_CONFIG }

/**
 * Why this prompt asks the summary to QUOTE rather than only point.
 *
 * Measured with the eval harness (eval/harness.ts), sweeping the shunt
 * threshold against how much verbatim content a summary carries, with a
 * deref round trip priced at 2000 chars:
 *
 *   summary carries        best threshold   total cost   vs shunt off
 *   nothing verbatim              16384       296,764         -3.5%
 *   ~10 quoted lines               8192       250,739        -18.5%
 *   ~30 quoted lines               2048        93,603        -69.6%
 *
 * The mechanism is not subtle: a fact present in the summary is free, and a
 * fact merely pointed at costs a deref — another tool call, another turn,
 * the whole conversation re-sent. At the richest setting `recoverable` fell
 * to zero, meaning the summary alone answered every probed fact.
 *
 * The previous version of this prompt said "your job is orientation, not
 * reproduction", which is exactly the top row: the shipped configuration was
 * sitting in the one regime where the shunt barely pays for itself. A longer
 * summary does cost more context per result, and the numbers above already
 * charge for that — it wins anyway, because eliminating round trips is worth
 * more than the characters the quotes cost.
 */
const SUMMARY_SYSTEM_PROMPT = `You are summarizing a tool result so a coding agent can work from the summary alone. The full text stays retrievable by line range, but every retrieval costs a round trip — so the summary should carry the facts, not just point at them.

Produce, in plain text:
1. One line: what this content is.
2. A map of its parts, each as "LINE_START-LINE_END  name — one clause". Cover the whole content; merge trivial regions. Aim for 5-20 entries.
3. "Key lines:" — the distinctive lines a reader would otherwise have to fetch, quoted VERBATIM and prefixed with their line number. Prefer signatures, exported names, error strings, config values, thresholds, and anything surprising. Include as many as the content warrants; err on the side of quoting.
4. One line "Notable:" only if something would surprise the reader (an error, a TODO, a surprising dependency). Omit otherwise.

Rules: line numbers must be accurate — they are used to fetch exact bytes later. Quotes must be exact; never paraphrase a quoted line and never invent content. No markdown fences, no preamble, no closing remarks.`

/**
 * The worker is a swappable handler, not a hardcoded call.
 *
 * This is the piece Portal calls "AiKA mode": which model summarizes is a
 * property of the handler, not of the call site — swap in Gemini Flash, a
 * local model, or a deterministic stub and no plugin code changes. Default
 * (null) uses queryHaiku through the normal Claude Code pipeline.
 *
 * It is also the only way to exercise this path outside a booted app:
 * queryHaiku goes through config, which throws "Config accessed before
 * allowed" until the CLI has initialized.
 */
export type ShuntSummarizer = (input: {
  content: string
  toolName: string
  inputHint: string
  signal: AbortSignal
}) => Promise<string | null>

let summarizer: ShuntSummarizer | null = null

export function setShuntSummarizer(fn: ShuntSummarizer | null): void {
  summarizer = fn
}

/** Cheap content-identity hash; not a security boundary. */
function hashContent(text: string): string {
  let checksum = 0
  const step = Math.max(1, Math.floor(text.length / 64))
  for (let i = 0; i < text.length; i += step) {
    checksum = (checksum * 31 + text.charCodeAt(i)) | 0
  }
  return `${text.length}:${checksum}`
}

/**
 * Summaries are keyed by content identity, not by path+mtime: it costs
 * nothing extra, and it also covers Bash/Grep output, which has no path to
 * key on. Re-reading an unchanged file produces a fresh handle but identical
 * bytes, so it hits this cache and skips the worker call.
 */
const summaryCache = new Map<string, string>()
const MAX_CACHED_SUMMARIES = 200

/**
 * Summaries currently being produced, keyed by content identity.
 *
 * summaryCache only helps AFTER a call finishes, so two results with
 * identical content arriving together both missed it and both paid a worker
 * call. Sharing the in-flight promise makes concurrent duplicates cost one
 * call instead of N — which matters precisely in the parallel-tool case
 * this limit exists for.
 */
const inFlightSummaries = new Map<string, Promise<string>>()

/** Simple FIFO semaphore over worker calls. */
let activeWorkers = 0
const workerQueue: Array<() => void> = []

async function acquireWorkerSlot(): Promise<void> {
  if (activeWorkers < config.maxConcurrentWorkers) {
    activeWorkers++
    return
  }
  await new Promise<void>(resolve => workerQueue.push(resolve))
  activeWorkers++
}

function releaseWorkerSlot(): void {
  activeWorkers--
  const next = workerQueue.shift()
  if (next) next()
}

/** Observable so a test or an operator can see the limiter working. */
export function getWorkerConcurrency(): { active: number; queued: number; limit: number } {
  return { active: activeWorkers, queued: workerQueue.length, limit: config.maxConcurrentWorkers }
}

const stats = {
  summarized: 0,
  cacheHits: 0,
  failures: 0,
  skipped: 0,
  charsIn: 0,
  charsOut: 0,
}

const HANDLE_MARKER = /^\[handle:([^\]\s]+)\]/

function numberLines(text: string, maxChars: number): string {
  const lines = text.split('\n')
  const out: string[] = []
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    const numbered = `${i + 1}\t${lines[i]}`
    used += numbered.length + 1
    if (used > maxChars) {
      out.push(`… (truncated at line ${i + 1} of ${lines.length} for the worker)`)
      break
    }
    out.push(numbered)
  }
  return out.join('\n')
}

/** Default handler for the summarization effect: Haiku via the normal pipeline. */
async function summarizeWithHaiku(
  full: string,
  toolName: string,
  inputHint: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await queryHaiku({
    systemPrompt: asSystemPrompt([SUMMARY_SYSTEM_PROMPT]),
    userPrompt: [
      `Tool: ${toolName}`,
      inputHint ? `Requested: ${inputHint}` : '',
      '',
      'Content (line-numbered):',
      numberLines(full, config.maxInputChars),
    ]
      .filter(Boolean)
      .join('\n'),
    signal,
    options: {
      querySource: 'context_shunt_summary',
      enablePromptCaching: false,
      agents: [],
      isNonInteractiveSession: getIsNonInteractiveSession(),
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  return (Array.isArray(response.message.content) ? response.message.content : [])
    .filter(block => block.type === 'text')
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
}

async function summarize(
  full: string,
  toolName: string,
  inputHint: string,
): Promise<string | null> {
  const key = hashContent(full)
  const cached = summaryCache.get(key)
  if (cached !== undefined) {
    stats.cacheHits++
    return cached
  }

  // Coalesce concurrent duplicates onto one worker call.
  const existing = inFlightSummaries.get(key)
  if (existing) {
    stats.cacheHits++
    const shared = await existing.catch(() => '')
    return shared || null
  }

  const work = (async () => {
    await acquireWorkerSlot()
    try {
      const signal = AbortSignal.timeout(config.timeoutMs)
      return summarizer
        ? ((await summarizer({ content: full, toolName, inputHint, signal })) ?? '').trim()
        : await summarizeWithHaiku(full, toolName, inputHint, signal)
    } finally {
      releaseWorkerSlot()
    }
  })()
  inFlightSummaries.set(key, work)

  try {
    const text = await work

    if (!text) {
      stats.failures++
      return null
    }

    if (summaryCache.size >= MAX_CACHED_SUMMARIES) {
      const oldest = summaryCache.keys().next().value
      if (oldest !== undefined) summaryCache.delete(oldest)
    }
    summaryCache.set(key, text)
    return text
  } catch {
    // Worker unavailable, timed out, or rejected. The caller keeps
    // contextHandle's exact-bytes preview — strictly no worse than before.
    stats.failures++
    return null
  } finally {
    inFlightSummaries.delete(key)
  }
}

/** Summarize the input so the worker knows what was asked for. */
function describeInput(input: Record<string, unknown>): string {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : ''
    return `search for ${input.pattern}${path}`
  }
  if (typeof input.command === 'string') {
    const cmd = input.command
    return cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd
  }
  return ''
}

export function register(on: OnRegistrar): void {
  on('tool.content', async ($, e: any, next) => {
    const event = await next(e)
    if (!config.enabled) return event

    const handled =
      typeof event === 'string' ? event : (event?.content as string | undefined)
    if (typeof handled !== 'string') return event

    const toolName = (e.tool_name ?? 'unknown') as string
    if (config.tools && !config.tools.includes(toolName)) {
      stats.skipped++
      return event
    }

    // contextHandle runs inside this hook, so a large result already came
    // back as "[handle:res_xxxx] …". No marker means it was under
    // contextHandle's threshold and there is nothing worth a worker call.
    const match = HANDLE_MARKER.exec(handled)
    if (!match) return event

    const handle = match[1]!
    // peek, not deref: this is machinery reading the bytes, not the model
    // consuming them, and getHandleUtilization() must stay honest.
    const full = peekHandle(handle)
    if (!full || full.length < config.minChars) {
      stats.skipped++
      return event
    }

    const summary = await summarize(
      full,
      toolName,
      describeInput((e.tool_input ?? {}) as Record<string, unknown>),
    )
    if (!summary) return event

    const lineCount = full.split('\n').length
    const shunted = [
      `[handle:${handle}] ${toolName} result — ${lineCount} lines, ${full.length} chars (full text NOT in context)`,
      `Summarized by a worker model. To read exact bytes: deref("${handle}", startLine, endLine)`,
      '',
      summary,
    ].join('\n')

    stats.summarized++
    stats.charsIn += full.length
    stats.charsOut += shunted.length
    return shunted
  })
}

export function getShuntConfig(): ShuntConfig {
  return { ...config }
}

export function setShuntConfig(partial: Partial<ShuntConfig>): ShuntConfig {
  config = { ...config, ...partial }
  return { ...config }
}

export function resetShuntConfig(): void {
  config = { ...DEFAULT_CONFIG }
}

/**
 * charsSaved is the honest headline: how many characters of tool output
 * never entered the expensive model's context. Since context bytes are
 * re-sent every turn, the realized saving is this number multiplied by the
 * turns remaining in the session — which is why the effect compounds.
 */
export function getShuntStats(): {
  summarized: number
  cacheHits: number
  failures: number
  skipped: number
  charsIn: number
  charsOut: number
  charsSaved: number
  cachedSummaries: number
} {
  return {
    ...stats,
    charsSaved: Math.max(0, stats.charsIn - stats.charsOut),
    cachedSummaries: summaryCache.size,
  }
}

export function clearShunt(): void {
  summaryCache.clear()
  stats.summarized = 0
  stats.cacheHits = 0
  stats.failures = 0
  stats.skipped = 0
  stats.charsIn = 0
  stats.charsOut = 0
}
