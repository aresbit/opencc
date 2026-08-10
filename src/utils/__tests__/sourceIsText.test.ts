import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/**
 * No source file may contain a raw control character.
 *
 * Control characters make excellent separators — NUL for a map key, 0x1e/0x1f
 * for splitting `git log --format` output — and writing them as literal bytes
 * works at runtime, which is exactly why they slip through. What they cost is
 * reviewability: they are invisible in an editor, and a NUL additionally makes
 * git classify the whole file as binary, so `git diff` prints
 * "Bin 0 -> 4738 bytes" instead of the code and no reviewer sees the change at
 * all. This had already happened three times in this repository before the
 * check existed.
 *
 * The escape form produces an identical string. Tab, LF and CR are excluded
 * because they are ordinary text.
 */

const ROOT = join(import.meta.dir, '..', '..')
const SKIP_DIRS = new Set(['node_modules', '__snapshots__'])

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path)
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) {
      yield path
    }
  }
}

/** C0 controls other than tab (9), LF (10) and CR (13). */
function isDisallowedControl(byte: number): boolean {
  return (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127
}

describe('source files stay text', () => {
  test('no file under src/ contains a raw control character', () => {
    const offenders: string[] = []
    for (const path of sourceFiles(ROOT)) {
      const buffer = readFileSync(path)
      for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i]!
        if (!isDisallowedControl(byte)) continue
        const escape = `\\u${byte.toString(16).padStart(4, '0')}`
        offenders.push(
          `${path.slice(ROOT.length + 1)}: raw 0x${byte
            .toString(16)
            .padStart(2, '0')} at byte ${i} — write it as ${escape} instead`,
        )
        break
      }
    }
    expect(offenders).toEqual([])
  })

  test('the check would actually catch one', () => {
    // A guard that cannot fail is not a guard.
    expect(isDisallowedControl(0x00)).toBe(true)
    expect(isDisallowedControl(0x1e)).toBe(true)
    expect(isDisallowedControl(0x1f)).toBe(true)
    expect(isDisallowedControl(0x7f)).toBe(true)
    expect(isDisallowedControl(0x09)).toBe(false)
    expect(isDisallowedControl(0x0a)).toBe(false)
    expect(isDisallowedControl(0x0d)).toBe(false)
    expect(isDisallowedControl(0x41)).toBe(false)
  })
})
