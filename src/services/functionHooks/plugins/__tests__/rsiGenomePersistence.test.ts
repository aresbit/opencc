import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addAntibody,
  addCrystal,
  flushGenome,
  getGenome,
  getGenomeFile,
  initGenomePersistence,
  resetGenome,
  resetGenomePersistenceForTests,
  updateTaskProfile,
} from '../rsiGenome.js'

/**
 * The genome is the whole point of the RSI loop and it used to be a
 * process-local singleton: guards compiled on one run were gone on the next,
 * so the loop never compounded. These tests pin the property that fixes it —
 * what a session learned is on disk, and a later session starts from it.
 */

let dir = ''
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rsi-genome-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetGenomePersistenceForTests()
})

afterEach(async () => {
  resetGenomePersistenceForTests()
  resetGenome()
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(dir, { recursive: true, force: true })
})

describe('rsi genome persistence', () => {
  test('a mutation is on disk after a flush', async () => {
    await initGenomePersistence()
    addAntibody(
      { tool: 'Bash', errorPattern: 'command not found' },
      { type: 'warn', condition: 'always', message: 'look for a typo' },
    )
    addCrystal('greet', [{ tool: 'Bash', inputTemplate: { command: 'echo hi' } }], {}, [], 1)
    updateTaskProfile('refactor', true, 0.5)

    await flushGenome()

    const raw = await readFile(getGenomeFile(), 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.antibodies).toHaveLength(1)
    expect(parsed.antibodies[0].pattern.errorPattern).toBe('command not found')
    expect(parsed.crystals).toHaveLength(1)
    expect(parsed.curriculum.taskTypes.refactor.attempts).toBe(1)
  })

  test('a later session loads what the earlier one wrote', async () => {
    await initGenomePersistence()
    addAntibody(
      { tool: 'Edit', errorPattern: 'string not found' },
      { type: 'block', condition: 'always', message: 're-read the file' },
    )
    await flushGenome()

    // Simulate a fresh process: forget the in-memory genome and every bit of
    // persistence bookkeeping, then load again from the same config home.
    resetGenomePersistenceForTests()
    resetGenome()
    await initGenomePersistence()

    const antibodies = getGenome().antibodies
    expect(antibodies).toHaveLength(1)
    expect(antibodies[0].pattern.tool).toBe('Edit')
  })

  test('ids handed out after a load do not collide with loaded ones', async () => {
    await initGenomePersistence()
    const first = addAntibody(
      { tool: 'Bash', errorPattern: 'x' },
      { type: 'warn', condition: 'always', message: 'm' },
    )
    await flushGenome()

    resetGenomePersistenceForTests()
    resetGenome()
    await initGenomePersistence()

    const second = addAntibody(
      { tool: 'Bash', errorPattern: 'y' },
      { type: 'warn', condition: 'always', message: 'm' },
    )
    expect(second.id).not.toBe(first.id)
    expect(getGenome().antibodies).toHaveLength(2)
  })

  test('mutating without initialising persistence writes nothing', async () => {
    // No initGenomePersistence() call: gated off, so a stray unit test that
    // pokes the genome cannot touch the developer's real config home.
    addAntibody(
      { tool: 'Bash', errorPattern: 'z' },
      { type: 'warn', condition: 'always', message: 'm' },
    )
    await flushGenome()
    await expect(readFile(getGenomeFile(), 'utf-8')).rejects.toThrow()
  })
})
