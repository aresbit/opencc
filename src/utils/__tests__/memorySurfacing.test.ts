import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  RELEVANT_MEMORIES_CONFIG,
  readMemoriesForSurfacing,
} from '../attachments.js'

/**
 * What the caps are for, and what they cost.
 *
 * The surfacer hands the agent the memory files it ranked as relevant, up to
 * five per turn, inside a <system-reminder>. At the original 4KB an ordinary
 * memory.md arrived as its frontmatter, its opening section, and a note saying
 * to go read the rest — a round trip a long-running agent pays once per
 * session for a file it was already given.
 *
 * These fix the sizes at their boundaries, because a per-file cap is only
 * meaningful next to the per-turn and per-session budgets built on top of it.
 */

async function withTempFile<T>(
  contents: string,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'memory-surfacing-'))
  try {
    const path = join(dir, 'memory.md')
    writeFileSync(path, contents)
    return await run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A memory file of roughly `bytes` bytes, in lines of about `lineBytes`. */
function memoryOf(bytes: number, lineBytes = 58): string {
  const body = 'context '.repeat(Math.ceil(lineBytes / 8))
  const line = `- ${body.slice(0, Math.max(1, lineBytes - 3))}\n`
  return line.repeat(Math.ceil(bytes / line.length))
}

describe('per-file cap', () => {
  test('a memory file under the cap surfaces whole', async () => {
    const contents = memoryOf(9000)
    const [surfaced] = await withTempFile(contents, path =>
      readMemoriesForSurfacing([{ path, mtimeMs: Date.now() }]),
    )

    expect(surfaced).toBeDefined()
    // The point of 10KB over 4KB: a file this size is no longer a fragment
    // plus an instruction to read the file.
    expect(surfaced!.content).not.toContain('was truncated')
    expect(surfaced!.content.trimEnd().endsWith('context')).toBe(true)
  })

  test('a file over the cap is truncated, not dropped', async () => {
    const [surfaced] = await withTempFile(memoryOf(40_000), path =>
      readMemoriesForSurfacing([{ path, mtimeMs: Date.now() }]),
    )

    expect(surfaced).toBeDefined()
    // findRelevantMemories already ranked this file first; surfacing its
    // opening beats surfacing nothing, so truncation carries a pointer to the
    // whole file rather than the file being skipped.
    expect(surfaced!.content).toContain('was truncated')
    expect(surfaced!.content).toContain('10240 byte limit')
  })

  test('the line cap does not bind before the byte cap', async () => {
    // Short lines are the case that mattered: at 40 bytes a line, 200 lines is
    // ~8KB — under the byte cap, so raising the byte cap alone would have
    // changed nothing for exactly the files it was raised for.
    const [surfaced] = await withTempFile(memoryOf(9000, 40), path =>
      readMemoriesForSurfacing([{ path, mtimeMs: Date.now() }]),
    )
    expect(surfaced!.content.split('\n').length).toBeGreaterThan(200)
    expect(surfaced!.content).not.toContain('was truncated')
  })

  test('an unreadable path is skipped rather than failing the turn', async () => {
    const surfaced = await readMemoriesForSurfacing([
      { path: join(tmpdir(), 'memory-surfacing-does-not-exist.md'), mtimeMs: 0 },
    ])
    expect(surfaced).toHaveLength(0)
  })
})

describe('session budget', () => {
  test('holds three full injections, as its comment claims', () => {
    // The budget is derived, not independent: five files per turn at the
    // per-file cap, three turns' worth. Left at its old value against the
    // larger per-file cap it would have been barely one injection, cutting a
    // long session's recall off after the first turn.
    const perTurn = 5 * 10240
    expect(RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES).toBeGreaterThanOrEqual(
      perTurn * 3,
    )
  })
})
