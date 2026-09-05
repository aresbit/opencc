/**
 * Transactional Edits — fearless refactoring with mechanical rollback.
 *
 * Intercepts Write/Edit tool calls and snapshots affected files before
 * modification. If a subsequent test command (npm test, bun test, etc.)
 * fails, all edits since the last snapshot are rolled back automatically.
 *
 * The model gains transactional semantics: it can attempt large
 * refactors knowing the blast radius is mechanically bounded.
 *
 * Failure policy: FAIL-OPEN — transaction tracking failing should not
 * prevent edits from going through.
 */

import type { OnRegistrar } from '../types.js'

interface Transaction {
  id: string
  startedAt: number
  snapshots: Map<string, string>
  editedFiles: string[]
}

let activeTx: Transaction | null = null
let txCounter = 0

const TEST_COMMANDS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bmake\s+test\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bmocha\b/,
  /\btsc\b.*--noEmit/,
]

function isTestCommand(cmd: string): boolean {
  return TEST_COMMANDS.some(p => p.test(cmd))
}

async function readFileContent(filePath: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

async function writeFileContent(filePath: string, content: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf-8')
}

async function snapshotFile(filePath: string): Promise<void> {
  if (!activeTx) {
    txCounter++
    activeTx = {
      id: `tx_${txCounter.toString(16).padStart(4, '0')}`,
      startedAt: Date.now(),
      snapshots: new Map(),
      editedFiles: [],
    }
  }

  if (!activeTx.snapshots.has(filePath)) {
    const content = await readFileContent(filePath)
    if (content !== null) {
      activeTx.snapshots.set(filePath, content)
    }
  }
  activeTx.editedFiles.push(filePath)
}

function looksLikeTestFailure(resultStr: string): boolean {
  const failureIndicators = [
    /\bFAIL(?:ED|URE)?\b/i,
    /\berror\b.*\btest/i,
    /\d+\s+(?:failing|failed)/i,
    /exit\s+code\s+[1-9]/i,
    /non-zero\s+exit/i,
    /AssertionError/i,
    /ELIFECYCLE/,
  ]
  return failureIndicators.some(p => p.test(resultStr))
}

/**
 * Rollback is OFF by default.
 *
 * This hook overwrites files on disk from snapshots when a test command's
 * output looks like a failure. That is a destructive action taken on a regex
 * match, so it must be an explicit choice rather than something that starts
 * happening because a reading bug got fixed.
 *
 * History worth keeping, because a plain `git revert` of that fix would be
 * the wrong move: the pre-fix code read `JSON.stringify(event)` instead of
 * the command's output, and the serialized event embeds tool_input.command.
 * Since snapshotFile() opens a transaction implicitly on any Write/Edit,
 * a command like `bun test 2>&1 | grep -i fail`, or a path such as
 * tests/test_failure_handling.py, matched /\bFAIL(?:ED|URE)?\b/ and rolled
 * the user's edits back WHILE THE TESTS WERE PASSING. So the old code was a
 * narrow landmine, not merely inert. Reading the real output is the fix;
 * this flag is what makes acting on it consensual.
 *
 * Snapshots are still taken while disabled — they cost only memory, and they
 * are what makes rollbackManual() usable on demand. shadowRollbacks counts
 * how often an automatic rollback WOULD have fired, so the false-positive
 * rate can be measured before anyone turns this on.
 */
let rollbackEnabled = false
let shadowRollbacks = 0

export function setTransactionRollbackEnabled(on: boolean): boolean {
  rollbackEnabled = on
  return rollbackEnabled
}

export function getTransactionStats(): {
  rollbackEnabled: boolean
  shadowRollbacks: number
  activeSnapshots: number
} {
  return {
    rollbackEnabled,
    shadowRollbacks,
    activeSnapshots: activeTx?.snapshots.size ?? 0,
  }
}

export function register(on: OnRegistrar): void {
  on('tool.call', { tool_name: 'Write' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    if (filePath) {
      try { await snapshotFile(filePath) } catch { /* fail-open */ }
    }
    return next(e)
  })

  on('tool.call', { tool_name: 'Edit' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    if (filePath) {
      try { await snapshotFile(filePath) } catch { /* fail-open */ }
    }
    return next(e)
  })

  // 'tool.content', not 'tool.result'. This was worse than dead: on
  // tool.result, next(e) returns the EVENT OBJECT, so resultStr was
  // JSON.stringify(event) — which embeds tool_input.command. The failure
  // detection was therefore matching against the command line rather than
  // the command's output, so a command whose text happened to contain a
  // failure indicator could roll back the user's files on a passing test.
  // On tool.content resultStr is the actual output, which is what
  // looksLikeTestFailure() was always meant to read.
  on('tool.content', { tool_name: 'Bash' }, async ($, e: any, next) => {
    const event = await next(e)
    const result =
      typeof event === 'string' ? event : (event?.content as string | undefined)
    const cmd = e.tool_input?.command as string

    if (!cmd || !isTestCommand(cmd) || !activeTx) return event
    if (typeof result !== 'string') return event

    const resultStr = result

    if (looksLikeTestFailure(resultStr) && activeTx.snapshots.size > 0) {
      if (!rollbackEnabled) {
        // Measure, don't act. The transaction stays open so a deliberate
        // rollbackManual() can still use its snapshots.
        shadowRollbacks++
        return event
      }
      const tx = activeTx
      activeTx = null

      const rolledBack: string[] = []
      for (const [filePath, original] of tx.snapshots) {
        try {
          await writeFileContent(filePath, original)
          rolledBack.push(filePath)
        } catch { /* best effort */ }
      }

      return [
        resultStr,
        '',
        `[transaction:${tx.id}] Test failed — rolled back ${rolledBack.length} file(s):`,
        ...rolledBack.map(f => `  ↩ ${f}`),
        `Edits reverted to pre-transaction state. Review the error and try a different approach.`,
      ].join('\n')
    }

    if (!looksLikeTestFailure(resultStr) && activeTx) {
      activeTx = null
    }

    return event
  })
}

export function getActiveTransaction(): { id: string; files: number; age: number } | null {
  if (!activeTx) return null
  return {
    id: activeTx.id,
    files: activeTx.snapshots.size,
    age: Date.now() - activeTx.startedAt,
  }
}

export async function rollbackManual(): Promise<string[]> {
  if (!activeTx) return []
  const rolledBack: string[] = []
  for (const [filePath, original] of activeTx.snapshots) {
    try {
      await writeFileContent(filePath, original)
      rolledBack.push(filePath)
    } catch { /* best effort */ }
  }
  activeTx = null
  return rolledBack
}

export function clearTransaction(): void {
  activeTx = null
}
