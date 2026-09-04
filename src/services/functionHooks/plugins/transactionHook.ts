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

export function register(on: OnRegistrar): void {
  on('tool.call', { tool: 'Write' }, async ($, e: any, next) => {
    const filePath = e.input?.file_path as string
    if (filePath) {
      try { await snapshotFile(filePath) } catch { /* fail-open */ }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e: any, next) => {
    const filePath = e.input?.file_path as string
    if (filePath) {
      try { await snapshotFile(filePath) } catch { /* fail-open */ }
    }
    return next(e)
  })

  on('tool.result', { tool: 'Bash' }, async ($, e: any, next) => {
    const result = await next(e)
    const cmd = e.input?.command as string

    if (!cmd || !isTestCommand(cmd) || !activeTx) return result

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? '')

    if (looksLikeTestFailure(resultStr) && activeTx.snapshots.size > 0) {
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

    return result
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
