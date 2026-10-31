/**
 * cache-stats — did the prefix cache actually get used?
 *
 * `usage.record` already carries the answer every response: four token
 * buckets, per call and cumulatively. What it does not carry is a judgement,
 * and the judgement is the whole point — a cache that never hits looks
 * exactly like a fast session until you divide.
 *
 *   hitRate = cacheRead / (cacheRead + cacheCreation + input)
 *
 * cacheRead is the part served from cache; cacheCreation is the part written
 * into it; input is the uncached remainder. Dividing by the sum, rather than
 * by input alone, is what keeps a first turn (all creation, no read) at 0
 * instead of undefined.
 *
 * Not every provider reports cache creation. Anthropic's API does; an
 * OpenAI-compatible proxy may only report hits, leaving cacheCreation at 0
 * forever — which would show a permanent, misleading "written 0%". The
 * composer therefore omits the write share when the ledger has never seen a
 * creation token, instead of claiming the cache was never written.
 *
 * This is an observer: the chain's answer is ignored and nothing here changes
 * what was counted. The service is what other mods consume — a budget mod
 * that wants "spend per cached token" reads it instead of re-deriving.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/** Where the ledger lives. Resolved when the mod registers, not at import:
 *  the config directory is per-process, and a test (or a second engine) that
 *  points `CLAUDE_CONFIG_DIR` somewhere else must get its own ledger. */
const ledgerPath = () =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'cache-stats', 'ledger.json')

type Counts = {
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  costUSD: number
}

const zero = (): Counts => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0 })
const today = () => new Date().toISOString().slice(0, 10)

type Ledger = { day: string; counts: Counts }

function load(file: string): Ledger {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Ledger
    if (raw.day === today() && raw.counts) return raw
  } catch {}
  return { day: today(), counts: zero() }
}

function save(file: string, ledger: Ledger): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(ledger, null, 2))
  } catch {}
}

function ratio(c: Counts) {
  const denom = c.cacheRead + c.cacheCreate + c.input
  const hitRate = denom > 0 ? c.cacheRead / denom : 0
  const writeShare = denom > 0 ? c.cacheCreate / denom : 0
  return { hitRate, writeShare }
}

export function register(on: any, options: any, ctx: any) {
  const warnBelow = Number(options?.warnBelow ?? 0.5)
  const refreshMs = Number(options?.refreshMs ?? 2000)

  const file = ledgerPath()
  let ledger = load(file)
  const session = zero()
  let gauge: { tokens: number; budget: number; percentLeft: number } | null = null
  let model = ''
  let lastRefresh = 0

  const snapshot = () => {
    const dayRatio = ratio(ledger.counts)
    const sessionRatio = ratio(session)
    return {
      day: ledger.counts,
      session,
      hitRate: dayRatio.hitRate,
      sessionHitRate: sessionRatio.hitRate,
      writeShare: dayRatio.writeShare,
      context: gauge,
      model,
      warnBelow,
    }
  }

  // `?.` on purpose: the panel and the commands stand on their own, and a
  // build that predates mod services is still a fine host for them — the
  // service is what another mod gets when the engine has one.
  ctx.provide?.('cache.stats', { get: snapshot, hitRate: () => ratio(ledger.counts).hitRate })

  const maybeRefresh = () => {
    const now = Date.now()
    if (now - lastRefresh < refreshMs) return
    lastRefresh = now
    ctx.desktop?.refresh?.()
  }

  on('usage.record', (_$: any, e: any, next: any) => {
    const call = e?.call
    if (!call) return next(e)
    if (ledger.day !== today()) ledger = { day: today(), counts: zero() }

    for (const target of [ledger.counts, session]) {
      target.calls += 1
      target.input += Number(call.inputTokens ?? 0)
      target.output += Number(call.outputTokens ?? 0)
      target.cacheRead += Number(call.cacheReadInputTokens ?? 0)
      target.cacheCreate += Number(call.cacheCreationInputTokens ?? 0)
      target.costUSD += Number(call.costUSD ?? 0)
    }
    if (typeof e.model === 'string' && e.model) model = e.model
    if (e.context && typeof e.context.tokens === 'number') gauge = e.context

    save(file, ledger)
    maybeRefresh()
    return next(e)
  })

  // A compaction is the moment the prefix is rebuilt from scratch: the next
  // turn's hit rate is expected to dip, and this note is what makes that dip
  // explainable instead of alarming.
  on('session.compact.post', (_$: any, e: any, next: any) => {
    const at = new Date().toISOString()
    try {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(
        join(DIR, 'compactions.log'),
        `${at} compacted; hitRate=${ratio(ledger.counts).hitRate.toFixed(3)} ctx=${gauge ? gauge.tokens : '?'}\n`,
        { flag: 'a' },
      )
    } catch {}
    ctx.ui?.toast?.({ message: 'cache-stats: context compacted, prefix rebuild expected', tone: 'info' })
    return next(e)
  })

  ctx.desktop?.slot?.('composer', () => {
    const { hitRate, writeShare } = ratio(ledger.counts)
    const items = [
      { label: 'cache hit', value: `${Math.round(hitRate * 100)}%`, tone: hitRate >= warnBelow ? 'success' : 'warn' },
    ]
    // A provider that never reports creation tokens would otherwise show a
    // permanent "written 0%"; omit the metric rather than misreport it.
    if (ledger.counts.cacheCreate > 0) {
      items.push({ label: 'written', value: `${Math.round(writeShare * 100)}%` })
    }
    if (gauge) {
      items.push({
        label: 'context',
        value: `${Math.round(100 - gauge.percentLeft)}% used`,
        tone: gauge.percentLeft <= 20 ? 'danger' : 'default',
      })
    }
    const children: any[] = [{ type: 'Metrics', items }]
    if (gauge && gauge.percentLeft <= 20) {
      children.push({
        type: 'Callout',
        tone: 'warn',
        text: `${gauge.percentLeft}% of the context window is left. Compaction is close; a long tool output now costs more than it looks.`,
      })
    }
    return { title: 'Cache', tree: { type: 'Box', direction: 'column', children } }
  })

  on('command.invoke', { command: 'stats' }, () => snapshot())

  on('command.invoke', { command: 'reset' }, () => {
    ledger = { day: today(), counts: zero() }
    save(file, ledger)
    ctx.desktop?.refresh?.()
    return { cleared: true, day: ledger.day }
  })
}
