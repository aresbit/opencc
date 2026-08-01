/**
 * Autoresearch eval for the CodeAct error remapper.
 *
 * The metric is blunt on purpose: for each captured real stderr sample, does
 * the remapped output report the line the user actually wrote, and has every
 * ephemeral absolute sandbox path been removed? A remapper that scores less
 * than 1.0 here is telling the model to edit the wrong line — the exact
 * failure the module exists to prevent.
 *
 * Run:  bun run src/utils/codeActErrorRemap.eval.ts
 *       bun run src/utils/codeActErrorRemap.eval.ts --verbose
 *
 * Samples are captured from real runs (see the probe transcripts in the PR
 * that introduced this file). When a new trace dialect breaks remapping, add
 * the raw stderr here before fixing the regex — the corpus is the spec.
 */

import { remapCodeActError, type RemapContext } from './codeActErrorRemap.js'

type Case = {
  label: string
  stderr: string
  ctx: RemapContext
  /** The line the user actually wrote the error on. */
  trueUserLine: number
  /** A fragment that must appear (e.g. the friendly filename). */
  mustContain?: string
}

// Header line counts match the importHint blocks in codeActSandbox.ts.
const TS: RemapContext = { headerLines: 13, agentBasename: 'agent.ts', sandboxDir: '/home/u/.claude/codeact/sandbox/exec_1', displayName: 'code.ts' }
const PY: RemapContext = { headerLines: 13, agentBasename: 'agent.py', sandboxDir: '/home/u/.claude/codeact/sandbox/exec_2', displayName: 'code.py' }
const C: RemapContext = { headerLines: 10, agentBasename: 'agent.c', sandboxDir: '/home/u/.claude/codeact/sandbox/exec_3', displayName: 'code.c' }

const CASES: Case[] = [
  {
    label: 'bun stack frame + code gutter',
    // User wrote `throw` on their line 3 → sandbox line 16.
    stderr:
      '14 | const a = 1\n' +
      '15 | const b = 2\n' +
      '16 | throw new Error(\'boom\')\n' +
      '            ^\n' +
      'error: boom\n' +
      '      at /home/u/.claude/codeact/sandbox/exec_1/agent.ts:16:11\n' +
      '      at loadAndEvaluateModule (2:1)',
    ctx: TS,
    trueUserLine: 3,
    mustContain: 'code.ts:3',
  },
  {
    label: 'python traceback',
    stderr:
      'Traceback (most recent call last):\n' +
      '  File "/home/u/.claude/codeact/sandbox/exec_2/agent.py", line 16, in <module>\n' +
      '    raise ValueError("bad")\n' +
      'ValueError: bad',
    ctx: PY,
    trueUserLine: 3,
    mustContain: 'code.py", line 3',
  },
  {
    label: 'gcc diagnostic + gutter',
    stderr:
      '/home/u/.claude/codeact/sandbox/exec_3/agent.c: In function ‘main’:\n' +
      '/home/u/.claude/codeact/sandbox/exec_3/agent.c:11:13: error: unknown type name ‘this’\n' +
      '   11 | int main(){ this is not valid c }\n' +
      '      |             ^~~~',
    ctx: C,
    trueUserLine: 1,
    mustContain: 'code.c:1',
  },
  {
    label: 'user message containing "line N" is not corrupted',
    // The remapper must fix the traceback location but leave the digits in the
    // user's own message ("... at line 42") untouched. A greedy `line \d+`
    // rewrite mangled both.
    stderr:
      'Traceback (most recent call last):\n' +
      '  File "/home/u/.claude/codeact/sandbox/exec_2/agent.py", line 16, in <module>\n' +
      '    raise ValueError("config broke at line 42")\n' +
      'ValueError: config broke at line 42',
    ctx: PY,
    trueUserLine: 3,
    mustContain: 'at line 42',
  },
  {
    label: 'header-internal frame is hidden',
    // A trace pointing at the import hint (line 5) should not surface as a
    // real user line, and its code-gutter frame should be dropped.
    stderr:
      ' 5 | //   import path from \'./builtins/path.js\'\n' +
      'error: something\n' +
      '      at /home/u/.claude/codeact/sandbox/exec_1/agent.ts:5:1',
    ctx: TS,
    trueUserLine: 0,
    mustContain: 'code.ts:0',
  },
]

function firstReportedLine(remapped: string, display: string): number | null {
  // Prefer an `at display:LINE` frame; fall back to Python `line N`.
  const at = new RegExp(`${display.replace('.', '\\.')}:(\\d+)`).exec(remapped)
  if (at) return Number(at[1])
  const py = /\bline (\d+)/.exec(remapped)
  return py ? Number(py[1]) : null
}

function run(verbose: boolean): number {
  let passed = 0
  for (const c of CASES) {
    const display = c.ctx.displayName ?? 'code'
    const out = remapCodeActError(c.stderr, c.ctx)

    const reported = firstReportedLine(out, display)
    const lineOk = reported === c.trueUserLine
    const noAbsPath = !out.includes('/sandbox/') && !out.includes(c.ctx.agentBasename)
    const containsOk = c.mustContain ? out.includes(c.mustContain) : true
    const ok = lineOk && noAbsPath && containsOk

    if (ok) passed++
    if (verbose || !ok) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label}`)
      if (!ok) {
        console.log(`   reported line ${reported}, want ${c.trueUserLine} (lineOk=${lineOk}, noAbsPath=${noAbsPath}, contains=${containsOk})`)
        console.log(out.split('\n').map(l => '      ' + l).join('\n'))
      }
    }
  }
  const score = passed / CASES.length
  console.log(`\nCURRENT: ${passed}/${CASES.length} = ${score.toFixed(4)}`)
  return score
}

const score = run(process.argv.includes('--verbose'))
process.exitCode = score === 1 ? 0 : 1
