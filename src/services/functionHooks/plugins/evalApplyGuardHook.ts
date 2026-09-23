/**
 * Eval/apply guard — give the admission rule teeth.
 *
 * MateBot's eval/apply ledger decides admission well. `deriveStatus` is
 * deterministic: any `fail` rejects, too few evaluations means evaluating,
 * and only all-pass above the risk threshold reaches `ready`. Independence is
 * counted by the evaluating agent's runtime id rather than by a label the
 * model picks, so one agent cannot be two evaluators. The role split holds up
 * too — researcher, planner and evaluator are all denied Edit/Write, so
 * nobody grades work they can fix.
 *
 * And none of it binds a write. The gate governs exactly one action —
 * `eval_apply apply` — while `builder` and `worker` carry `tools: ['*']` and
 * can Edit the real file directly, having never proposed a run. The whole
 * apparatus constrains only the agent that volunteers to route through it.
 *
 * This is the same shape as two other gates in this codebase: a good
 * deterministic judge reached by an optional path. `tool.call` is not
 * optional, which is the entire reason this belongs in the chain rather than
 * in the tool.
 *
 * ── Shadow first ──────────────────────────────────────────────────────
 *
 * Off by default, in the sense that matters: it observes and records, and
 * refuses nothing until `setEvalApplyEnforcing(true)`. Same convention as
 * cache, transaction and taintFirewall — they act, so acting is opt-in. It
 * also happens to be the honest order of operations. Nobody knows yet how
 * many writes in a real swarm run bypass the ledger; turning enforcement on
 * before that number exists would either be a no-op nobody notices or a wall
 * that stops every session, and there is no way to tell which in advance.
 * Run a swarm, read `$.evalApply.stats()`, then decide.
 */

import { isAbsolute, relative, resolve } from 'path'
import { isCoordinatorMode } from '../../../coordinator/coordinatorMode.js'
import type { OnRegistrar } from '../types.js'
import { logForDebugging } from '../../../utils/debug.js'

const GUARDED_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const

/** Paths the ledger and the run metadata itself live under. */
const LEDGER_DIR = '.matebot'

export interface BypassRecord {
  path: string
  tool: string
  agentId?: string
  agentType?: string
  at: number
}

export interface EvalApplyGuardStats {
  /** False outside `--matebot`, which is why every other number is zero. */
  coordinatorMode: boolean
  /** When false, `blocked` is what enforcement WOULD have refused. */
  enforcing: boolean
  writes: number
  covered: number
  bypassed: number
  blocked: number
  /** Which agent wrote past the ledger, and how often. */
  byAgent: Record<string, number>
  recentBypasses: BypassRecord[]
}

const MAX_RECENT = 50

let enforcing = false
let stats = {
  writes: 0,
  covered: 0,
  bypassed: 0,
  blocked: 0,
  byAgent: {} as Record<string, number>,
  recent: [] as BypassRecord[],
}

export function setEvalApplyEnforcing(value: boolean): void {
  enforcing = value
}

export function isEvalApplyEnforcing(): boolean {
  return enforcing
}

/**
 * Test seam for the repository root.
 *
 * Production always asks `getSharedProjectRoot()`, which resolves through
 * git so sibling worktrees share one ledger. A test cannot make that answer a
 * temp directory without being inside a repository it created, so it says so
 * directly instead — the same shape as `resetMateBotModeForTesting`.
 */
let rootOverride: string | undefined
export function setEvalApplyGuardRootForTesting(root: string | undefined): void {
  rootOverride = root
}

export function clearEvalApplyGuardStats(): void {
  stats = { writes: 0, covered: 0, bypassed: 0, blocked: 0, byAgent: {}, recent: [] }
}

export function getEvalApplyGuardStats(): EvalApplyGuardStats {
  return {
    coordinatorMode: coordinatorModeNow(),
    enforcing,
    writes: stats.writes,
    covered: stats.covered,
    bypassed: stats.bypassed,
    blocked: stats.blocked,
    byAgent: { ...stats.byAgent },
    recentBypasses: [...stats.recent],
  }
}

/**
 * Asked on every guarded write, so it goes through the one function that
 * decides this rather than re-deriving it. `matebotMode.ts` exists because
 * eight copies of `process.argv.includes('--matebot')` had drifted apart and
 * disagreed with the CLI parser about `--`; a ninth reading here, however
 * cheap, would be the same mistake with a different spelling.
 */
function coordinatorModeNow(): boolean {
  return isCoordinatorMode()
}

function pathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const candidate =
    (input as { file_path?: unknown }).file_path ??
    (input as { notebook_path?: unknown }).notebook_path ??
    (input as { path?: unknown }).path
  return typeof candidate === 'string' && candidate.trim() ? candidate : undefined
}

/** True when `child` is `parent` or sits underneath it. */
function covers(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The run that authorises writing this path, if there is one.
 *
 * `applied` counts as well as `ready`: a run whose apply already happened is
 * the normal state during follow-up edits to the artifacts it covers, and
 * treating it as uncovered would refuse the second half of a change it just
 * approved.
 */
async function findCoveringRun(
  filePath: string,
  root: string,
): Promise<{ id: string; status: string; explain?: string } | undefined> {
  const { EvalApplyLedger, explainNotReady } = await import(
    '../../../matebot/evalApplyLedger.js'
  )
  const runs = await new EvalApplyLedger(root).list()

  let nearest: { id: string; status: string; explain?: string } | undefined
  for (const run of runs) {
    for (const artifact of run.artifacts ?? []) {
      const absolute = isAbsolute(artifact) ? artifact : resolve(root, artifact)
      if (!covers(absolute, filePath)) continue
      if (run.status === 'ready' || run.status === 'applied') {
        return { id: run.id, status: run.status }
      }
      // Keep the newest non-ready run that names this path, so the refusal
      // can say what that run is still waiting for instead of only that no
      // run exists — a different problem with a different fix.
      nearest ??= { id: run.id, status: run.status, explain: explainNotReady(run) }
    }
  }
  return nearest
}

export function register(on: OnRegistrar): void {
  for (const tool of GUARDED_TOOLS) {
    on('tool.call', { tool_name: tool }, async ($, e: any, next) => {
      if (!coordinatorModeNow()) return next(e)

      const filePath = pathFromInput(e.tool_input ?? e.input)
      if (!filePath) return next(e)

      let root: string
      if (rootOverride) {
        root = rootOverride
      } else {
        try {
          const { getSharedProjectRoot } = await import(
            '../../../matebot/sharedProjectRoot.js'
          )
          root = await getSharedProjectRoot()
        } catch {
          return next(e)
        }
      }

      const absolute = isAbsolute(filePath) ? filePath : resolve(root, filePath)

      // Outside the repository is scratch, /tmp, a home-dir config — none of
      // it is the product code the gate exists to protect, and refusing it
      // would make the guard the reason a worker cannot write its own notes.
      if (!covers(root, absolute)) return next(e)
      // The ledger writes its own runs through this same path.
      if (covers(resolve(root, LEDGER_DIR), absolute)) return next(e)

      stats.writes++

      let run: Awaited<ReturnType<typeof findCoveringRun>>
      try {
        run = await findCoveringRun(absolute, root)
      } catch (error) {
        // An unreadable ledger must not become a write freeze. Fail open and
        // say so: a guard that blocks because it could not decide is worse
        // than one that is briefly wrong.
        logForDebugging(`[evalApplyGuard] ledger unreadable, allowing: ${error}`)
        return next(e)
      }

      if (run && (run.status === 'ready' || run.status === 'applied')) {
        stats.covered++
        return next(e)
      }

      stats.bypassed++
      const who = e.agent_type ?? e.agent_id ?? 'main'
      stats.byAgent[who] = (stats.byAgent[who] ?? 0) + 1
      stats.recent.push({
        path: absolute,
        tool,
        agentId: e.agent_id,
        agentType: e.agent_type,
        at: Date.now(),
      })
      if (stats.recent.length > MAX_RECENT) stats.recent.shift()

      if (!enforcing) {
        logForDebugging(
          `[evalApplyGuard] shadow: ${tool} ${absolute} is not covered by a ready run`,
        )
        return next(e)
      }

      stats.blocked++
      return {
        deny:
          run?.explain
            ? `eval/apply: ${run.explain} This write to ${relative(root, absolute) || absolute} is covered by run ${run.id}, which is not ready.`
            : `eval/apply: no ready run covers ${relative(root, absolute) || absolute}. ` +
              `Propose one with eval_apply({action:'propose', artifacts:[...]}), get the ` +
              `required independent evaluation(s), and write once it reaches ready. ` +
              `The gate exists so a change is judged before it lands, not after.`,
      }
    })
  }
}

/** Path helpers, exported for the tests that pin the matching rules. */
export const __testing = { covers, pathFromInput }
