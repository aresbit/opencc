/**
 * A record of what was actually measured, so a later claim can be checked
 * against it rather than believed.
 *
 * The completion gate's problem with `command` and `test` evidence is that
 * both are self-report about something that happened elsewhere: the model runs
 * a command in a Bash call, then tells `update_goal` what the output showed.
 * The gate can confirm a file exists, but it has no way to confirm a claim
 * about a command's behaviour — so "all tests pass" is admitted on the strength
 * of a sentence.
 *
 * This ledger closes that. Only the `rsi` tool writes to it, and it writes what
 * the process exit codes actually were. `admitEvidence` reads it. The model can
 * write the note, but it cannot write the counts, and it cannot un-measure a
 * measurement it dislikes: once a command is on record as flaky, a later claim
 * naming that command is checked against the flaky reading until a fresh
 * measurement supersedes it.
 *
 * Session-scoped and in memory on purpose. A measurement is a statement about
 * one state of one working tree; persisting it across sessions would mean
 * resurrecting claims about code that has since changed.
 */

import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getCwd } from '../../utils/cwd.js'
import type { EvidenceReading } from './estimators.js'

export interface Measurement {
  command: string
  cwd: string
  reading: EvidenceReading
  recordedAt: number
  /**
   * Working-tree state when the measurement was taken, or null outside a git
   * repository. A measurement describes the code as it was; if the tree has
   * moved on, the numbers are about something else.
   */
  treeFingerprint: string | null
}

/** Bounded so a long session cannot grow this without limit. */
const MAX_ENTRIES = 64

const ledger = new Map<string, Measurement>()

function keyOf(command: string, cwd: string): string {
  // Whitespace-insensitive so `pytest  -q` and `pytest -q` are one command;
  // nothing else is normalised, because a different flag is a different run.
  return `${cwd}\u0000${command.trim().replace(/\s+/g, ' ')}`
}

export function recordMeasurement(entry: Measurement): void {
  const key = keyOf(entry.command, entry.cwd)
  // Re-inserting moves the entry to the end, which keeps the eviction order
  // least-recently-written rather than first-ever-written.
  ledger.delete(key)
  ledger.set(key, entry)
  while (ledger.size > MAX_ENTRIES) {
    const oldest = ledger.keys().next()
    if (oldest.done) break
    ledger.delete(oldest.value)
  }
}

export function lookupMeasurement(
  command: string,
  cwd: string = getCwd(),
): Measurement | undefined {
  return ledger.get(keyOf(command, cwd))
}

/** Test seam. */
export function clearLedgerForTesting(): void {
  ledger.clear()
}

/** Test seam — asserting on eviction without exporting the map. */
export function ledgerSizeForTesting(): number {
  return ledger.size
}

/**
 * A cheap identity for the current working tree: HEAD plus the porcelain
 * status. Two measurements share a fingerprint exactly when the tracked
 * content they ran against is the same.
 *
 * Returns null outside a git repository, and callers must treat null as "no
 * staleness check available" rather than as "unchanged" — claiming a guarantee
 * that is not there is worse than admitting the gap.
 */
export async function treeFingerprint(
  cwd: string = getCwd(),
): Promise<string | null> {
  const result = await execFileNoThrowWithCwd(
    'git rev-parse HEAD 2>/dev/null; git status --porcelain 2>/dev/null',
    [],
    { shell: true, cwd, timeout: 10_000, preserveOutputOnError: false },
  )
  const out = result.stdout?.trim()
  if (!out) return null
  return hash(out)
}

/** FNV-1a. Not cryptographic — this compares against itself, nothing else. */
function hash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

export type StalenessVerdict = 'fresh' | 'stale' | 'unknown'

/**
 * Whether a recorded measurement still describes the current tree.
 *
 * `unknown` when either side has no fingerprint — outside git, or when the
 * check itself failed. It is reported as its own outcome rather than being
 * folded into `fresh`, so a caller never mistakes an absent check for a passed
 * one.
 */
export async function checkStaleness(
  measurement: Measurement,
  cwd: string = getCwd(),
): Promise<StalenessVerdict> {
  if (measurement.treeFingerprint === null) return 'unknown'
  const current = await treeFingerprint(cwd)
  if (current === null) return 'unknown'
  return current === measurement.treeFingerprint ? 'fresh' : 'stale'
}
