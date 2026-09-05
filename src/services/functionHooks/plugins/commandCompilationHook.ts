/**
 * Command compilation ("eliminate shell pipeline spawns") — investigated,
 * not built. Measurement contradicts the premise, the same way it did for
 * the process-pool proposal (#1 / processPoolHook.ts), and for the same
 * underlying reason: raw process fork/exec on this system is cheap.
 *
 * The proposal: detect shell pipelines (`cat f | grep x | wc -l`, `find |
 * xargs`, etc.) and rewrite them into fewer processes — e.g. a single
 * built-in-equivalent call — to save the fork+exec cost of each pipeline
 * stage.
 *
 * Measured (through the real production path, src/utils/Shell.ts's exec(),
 * post shell-snapshot-fix from processPoolHook.ts's investigation — see
 * that file for why the snapshot fix mattered here too: without it, the
 * ~350ms/call snapshot cost would have swamped any pipeline-stage signal
 * completely):
 *
 *   single command   (`grep foo file`):                       ~32-42ms
 *   2-stage pipeline (`cat file | grep foo | wc -l`):          ~30-49ms
 *   4-stage pipeline (`cat f | grep -v x | sort | uniq | wc`): ~30-48ms
 *
 * No measurable difference. Adding 1-3 extra pipeline stages costs at most
 * a couple of milliseconds — consistent with the ~2-5ms raw fork/exec
 * number measured in processPoolHook.ts — and disappears entirely into the
 * ~30ms baseline (bash startup + the fixed per-call bookkeeping) and, more
 * importantly, into the model round-trip this tool call sits inside
 * (hundreds of ms to seconds). There is nothing here worth rewriting a
 * command to save.
 *
 * It also wouldn't be safe to build even if the numbers had gone the other
 * way: automatically rewriting a pipeline the model deliberately wrote
 * (e.g. `cat foo | grep bar` → `grep bar foo`) changes observable behavior
 * it may be relying on — a missing `foo` produces a different error
 * (`cat`'s vs `grep`'s), multi-file `grep` prints filenames per match a
 * single-file rewrite wouldn't, exit-code semantics under `pipefail`
 * change with fewer stages, and SIGPIPE behavior differs. A hook silently
 * substituting a "faster" command for the exact one the model asked to run
 * is a correctness/transparency risk for a saving that isn't there.
 *
 * Re-measurable any time via benchmarkPipelineOverhead() below, since the
 * conclusion depends on the host this runs on, not a number frozen here.
 */

import type { OnRegistrar } from '../types.js'
import { exec } from '../../../utils/Shell.js'

/**
 * No hook to register — same reasoning as processPoolHook.ts: this
 * investigation concluded the mechanism shouldn't exist, so there's nothing
 * to intercept. register() is a deliberate no-op.
 */
export function register(_on: OnRegistrar): void {}

async function timeCommand(command: string, samples: number): Promise<number[]> {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    const controller = new AbortController()
    const start = performance.now()
    const shellCommand = await exec(command, controller.signal, 'bash', {})
    await shellCommand.result
    times.push(performance.now() - start)
  }
  return times.sort((a, b) => a - b)
}

/**
 * Re-measure single-command vs multi-stage-pipeline overhead on whatever
 * machine this runs on, through the real exec() path, so the "no
 * measurable difference" conclusion above is checkable evidence rather
 * than a number frozen in a comment.
 */
export async function benchmarkPipelineOverhead(samples = 5): Promise<{
  singleCommandMs: number[]
  twoStagePipelineMs: number[]
  fourStagePipelineMs: number[]
}> {
  // Warm the shell-snapshot cache first so its one-time cost (see
  // processPoolHook.ts) doesn't dominate the first sample.
  await timeCommand('true', 1)
  return {
    singleCommandMs: await timeCommand('grep foo /etc/hostname || true', samples),
    twoStagePipelineMs: await timeCommand(
      'cat /etc/hostname | grep foo | wc -l || true',
      samples,
    ),
    fourStagePipelineMs: await timeCommand(
      'cat /etc/hostname | grep -v xyz | sort | uniq | wc -l || true',
      samples,
    ),
  }
}
