/**
 * Persistent process pool — investigated; the literal proposal isn't built,
 * but the investigation found and fixed a real bug in the actual bottleneck.
 *
 * The ten-hooks proposal's #1 pick: keep a warm pool of shell processes so
 * repeated Bash tool calls skip spawn cost. Before building it, the actual
 * cost needed measuring — "obviously slow" isn't evidence, per this
 * session's rule of checking every claim against the real system first.
 *
 * Raw process spawn (child_process spawn of `/bin/bash -c true`, 30 samples,
 * this container): min 2.5ms, median 2.8ms, max 6.7ms. That's not a
 * bottleneck worth pooling for — a ~3ms fork/exec disappears next to a
 * model round-trip (hundreds of ms to multiple seconds).
 *
 * But the actual production path (src/utils/Shell.ts's exec()) measured
 * ~350ms per call in this container, not ~3ms — so the spawn benchmark
 * alone would have been the wrong answer to "is there a bottleneck." The
 * gap turned out to be real, and NOT process spawn:
 *
 * Every Bash call sources a per-session "shell snapshot" file (captures the
 * user's functions/aliases/exports so commands see their real shell
 * environment). The snapshot generator (src/utils/bash/ShellSnapshot.ts)
 * was writing one `eval "$(echo '<base64>' | base64 -d)"` line PER CAPTURED
 * FUNCTION. In this container's shell config (nvm + completions, 118
 * functions), that meant 118 forked `base64` subprocesses (each ~2.4ms,
 * `time bash -c "x=\$(echo ... | base64 -d)"`) on every single Bash tool
 * call, for the life of the session — real, repeated, measured cost, just
 * one layer down from where the proposal expected it (nested subprocess
 * forks during snapshot restoration, not the top-level command's shell).
 *
 * Fixed directly in ShellSnapshot.ts: batch every matched function into one
 * `declare -f $names` call and one base64 encode/decode instead of one per
 * function. Verified in this container: base64 decode count in the
 * generated snapshot dropped from 118 to 1, sourcing time dropped from
 * ~358ms to ~44ms (~8x), and the restored function set is byte-for-byte
 * identical (same 118 names, same bodies, diffed against the old snapshot;
 * the Shell Options/Aliases sections are untouched — same generation code
 * path either way). That fix landed as a normal code change, not a hook —
 * there's no hook interception point inside snapshot generation, the same
 * way there wasn't one for KV-cache prefix ordering.
 *
 * With that real bottleneck fixed at its source, re-measure via
 * benchmarkSpawnOverhead() below (goes through the real exec() path,
 * snapshot sourcing included) rather than trusting either number as frozen —
 * both depend on the host and the user's actual shell config.
 *
 * What's already amortized, correctly, without a pool:
 * - Shell/provider resolution (`getShellConfig`, `getPsProvider` in
 *   src/utils/Shell.ts) is `memoize`d — probing which shells exist on disk
 *   runs once per session.
 * - Snapshot GENERATION (the expensive `declare -F`/`typeset -f` scan) is
 *   also one-time per session; only restoration (sourcing) repeats per call,
 *   which is what the fix above targets.
 * - Sandbox initialization (`initializationPromise` in sandbox-adapter.ts)
 *   is one-time per session, not repeated per command.
 *
 * Why a literal process pool (reusing one live shell process across tool
 * calls) still isn't built, even after finding a real cost to amortize:
 * - It would still need the fix above or an equivalent — a pool of
 *   processes that each re-source a slow snapshot on first use doesn't
 *   avoid the cost, just moves it to pool-refill time.
 * - Reusing one live shell process across calls means env vars, exported
 *   functions, aliases, and shell options set by one command leak into the
 *   next. Today each Bash call is independent by construction — cwd is the
 *   one thing that persists, and it does so deliberately via reading back a
 *   `pwd -P` file after each command and passing it as the next spawn's
 *   `cwd`, not via a surviving process. Pooling would silently change that
 *   contract for everything else too.
 * - When sandboxing is enabled, each command's isolation (bwrap namespace)
 *   is a genuine per-invocation security boundary, not incidental overhead.
 *   Pooling sandboxed processes would mean reusing one process's namespace
 *   across commands that are supposed to be isolated from each other.
 *
 * PowerShell (much higher real startup cost — CLR init) wasn't measurable
 * in this container (pwsh not installed) and is the one place pooling
 * could plausibly still matter after a snapshot-equivalent fix there too.
 * It carries the identical state-leakage problem, so it isn't a free win —
 * flagging it here as the honest candidate for anyone revisiting this with
 * real PowerShell numbers, rather than building it on a guess.
 */

import type { OnRegistrar } from '../types.js'
import { exec } from '../../../utils/Shell.js'

/**
 * No hook to register — there is no interception point for a mechanism
 * this investigation concluded shouldn't exist. The real fix it found
 * (batched snapshot restoration) lives in ShellSnapshot.ts as a normal code
 * change, not here. register() is a deliberate no-op, matching the
 * precedent set by kvCacheAffinityHook.ts for a finding that's real but
 * isn't a hook.
 */
export function register(_on: OnRegistrar): void {}

/**
 * Re-measure real per-call Bash overhead on whatever machine this runs on,
 * through the actual production code path (src/utils/Shell.ts's exec(),
 * snapshot sourcing included), so the numbers above are checkable evidence,
 * not frozen in a comment.
 */
export async function benchmarkSpawnOverhead(samples = 10): Promise<{
  samples: number
  minMs: number
  medianMs: number
  maxMs: number
}> {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const controller = new AbortController()
    const start = performance.now()
    const shellCommand = await exec('true', controller.signal, 'bash', {})
    await shellCommand.result
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return {
    samples,
    minMs: times[0]!,
    medianMs: times[Math.floor(times.length / 2)]!,
    maxMs: times[times.length - 1]!,
  }
}
