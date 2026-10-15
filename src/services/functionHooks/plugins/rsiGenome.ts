/**
 * RSI Genome — Shared state module for Recursive Self-Improvement.
 *
 * The genome is the agent's evolvable DNA: antibodies, crystallized skills,
 * strategy records, critic rules, curriculum profiles, constitution, and
 * ratchet tests. Model weights are frozen; the genome is everything that
 * ISN'T frozen — prompt, tools, memory, hooks — and it's the hook layer
 * that makes it self-modifying.
 *
 * Two layers:
 *   - Evolvable: antibodies, skills, strategies, memory (can be mutated)
 *   - Immutable: constitution, metrics definitions, modification rules
 *     (structurally refuses mutation from the evolvable layer)
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

/**
 * The config home, resolved from the environment at call time.
 *
 * Deliberately not utils/envUtils.js's getClaudeConfigHomeDir. Four unrelated
 * test files replace that module process-wide with mock.module, and a mock
 * outlives the file that installed it — so importing it here pinned the
 * genome's location (and every test that isolates itself by setting
 * CLAUDE_CONFIG_DIR) to a stranger's temporary directory, which that file
 * deletes when it finishes. The rule below is exactly envUtils's; keeping it
 * local means the genome's location is answerable from the environment alone.
 */
function configHomeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).normalize('NFC')
}

// ── Types ───────────────────────────────────────────────────────

export interface Antibody {
  id: string
  pattern: FailurePattern
  guard: AntibodyGuard
  hitCount: number
  blockCount: number
  falsePositives: number
  createdAt: number
  generation: number
}

export interface FailurePattern {
  tool: string
  inputSignature?: string
  errorPattern: string
  contextHint?: string
}

export interface AntibodyGuard {
  type: 'block' | 'rewrite' | 'warn'
  condition: string
  replacement?: Record<string, unknown>
  message: string
}

export interface Crystal {
  id: string
  name: string
  sequence: CrystalStep[]
  paramConstraints: Record<string, unknown>
  prechecks: string[]
  successRate: number
  callCount: number
  createdAt: number
  generation: number
}

export interface CrystalStep {
  tool: string
  inputTemplate: Record<string, unknown>
  outputKey?: string
}

export interface StrategyRecord {
  id: string
  name: string
  taskType: string
  variants: StrategyVariant[]
  sampleSize: number
  concluded: boolean
  winner?: string
  createdAt: number
}

export interface StrategyVariant {
  label: string
  description: string
  config: Record<string, unknown>
  successes: number
  failures: number
  totalTime: number
  samples: number
}

export interface CriticRule {
  id: string
  condition: string
  decision: 'approve' | 'deny'
  confidence: number
  reason: string
  source: string
  hitCount: number
  createdAt: number
}

export interface CurriculumProfile {
  taskTypes: Record<string, TaskTypeProfile>
  totalExercises: number
  totalImprovement: number
}

export interface TaskTypeProfile {
  successRate: number
  attempts: number
  difficulty: number
  lastAttempt: number
  trend: number[]
}

export interface ConstitutionEntry {
  id: string
  invariant: string
  enforcement: 'structural' | 'checked'
  description: string
  createdAt: number
  immutable: true
}

export interface RatchetTest {
  id: string
  name: string
  assertion: string
  source: string
  createdAt: number
  lastRun?: number
  lastResult?: boolean
}

export interface GenomeMeta {
  generation: number
  lastSleep: number
  totalImprovements: number
  secondOrderAdjustments: number
  antibodyCompilations: number
  crystallizations: number
  experimentsRun: number
  createdAt: number
}

export interface RsiGenome {
  version: number
  antibodies: Antibody[]
  crystals: Crystal[]
  strategies: StrategyRecord[]
  criticRules: CriticRule[]
  curriculum: CurriculumProfile
  constitution: ConstitutionEntry[]
  ratchetTests: RatchetTest[]
  meta: GenomeMeta
}

// ── State ───────────────────────────────────────────────────────

let genome: RsiGenome = createEmptyGenome()
let idCounter = 0

// Persistence bookkeeping. `genomeSavedFingerprint` is the serialized form
// last written to disk; `genomeDirty` is set by every mutator and cleared by a
// successful flush. See the Persistence section at the bottom of this file.
let genomeDirty = false
let genomeFlushTimer: ReturnType<typeof setTimeout> | null = null
let genomeFlushInFlight: Promise<void> | null = null
let genomeLoadPromise: Promise<void> | null = null
let genomeLoaded = false
// Flushing is gated on this so a unit test that mutates the genome without
// ever initialising persistence cannot write to the developer's real
// ~/.claude/rsi/genome.json. initGenomePersistence() turns it on.
let genomePersistenceEnabled = false

const MAX_ANTIBODIES = 200
const MAX_CRYSTALS = 100
const MAX_STRATEGIES = 50
const MAX_CRITIC_RULES = 200
const MAX_RATCHET_TESTS = 500

export function createEmptyGenome(): RsiGenome {
  return {
    version: 1,
    antibodies: [],
    crystals: [],
    strategies: [],
    criticRules: [],
    curriculum: { taskTypes: {}, totalExercises: 0, totalImprovement: 0 },
    constitution: [],
    ratchetTests: [],
    meta: {
      generation: 0,
      lastSleep: 0,
      totalImprovements: 0,
      secondOrderAdjustments: 0,
      antibodyCompilations: 0,
      crystallizations: 0,
      experimentsRun: 0,
      createdAt: Date.now(),
    },
  }
}

export function genId(prefix: string): string {
  idCounter++
  return `${prefix}_${idCounter.toString(16).padStart(6, '0')}`
}

// ── Genome Access ──────────────────────────────────────────────

export function getGenome(): RsiGenome {
  return genome
}

export function getGenomeMeta(): GenomeMeta {
  return { ...genome.meta }
}

export function incrementGeneration(): void {
  genome.meta.generation++
  markGenomeDirty()
}

// ── Antibody Operations ────────────────────────────────────────

export function addAntibody(pattern: FailurePattern, guard: AntibodyGuard): Antibody {
  if (genome.antibodies.length >= MAX_ANTIBODIES) {
    const sorted = [...genome.antibodies].sort((a, b) => a.hitCount - b.hitCount)
    const victim = sorted[0]
    if (victim) {
      genome.antibodies = genome.antibodies.filter(a => a.id !== victim.id)
    }
  }

  const ab: Antibody = {
    id: genId('ab'),
    pattern,
    guard,
    hitCount: 0,
    blockCount: 0,
    falsePositives: 0,
    createdAt: Date.now(),
    generation: genome.meta.generation,
  }
  genome.antibodies.push(ab)
  genome.meta.antibodyCompilations++
  markGenomeDirty()
  return ab
}

export function getAntibodies(): Antibody[] {
  return genome.antibodies
}

export function findAntibody(tool: string, errorPattern: string): Antibody | undefined {
  return genome.antibodies.find(
    a => a.pattern.tool === tool && a.pattern.errorPattern === errorPattern,
  )
}

export function removeAntibody(id: string): boolean {
  const idx = genome.antibodies.findIndex(a => a.id === id)
  if (idx === -1) return false
  genome.antibodies.splice(idx, 1)
  markGenomeDirty()
  return true
}

// ── Crystal Operations ─────────────────────────────────────────

export function addCrystal(
  name: string,
  sequence: CrystalStep[],
  paramConstraints: Record<string, unknown>,
  prechecks: string[],
  successRate: number,
): Crystal {
  if (genome.crystals.length >= MAX_CRYSTALS) {
    const sorted = [...genome.crystals].sort((a, b) => a.callCount - b.callCount)
    const victim = sorted[0]
    if (victim) {
      genome.crystals = genome.crystals.filter(c => c.id !== victim.id)
    }
  }

  const crystal: Crystal = {
    id: genId('crys'),
    name,
    sequence,
    paramConstraints,
    prechecks,
    successRate,
    callCount: 0,
    createdAt: Date.now(),
    generation: genome.meta.generation,
  }
  genome.crystals.push(crystal)
  genome.meta.crystallizations++
  markGenomeDirty()
  return crystal
}

export function getCrystals(): Crystal[] {
  return genome.crystals
}

export function findCrystal(name: string): Crystal | undefined {
  return genome.crystals.find(c => c.name === name)
}

// ── Strategy Operations ────────────────────────────────────────

export function addStrategy(
  name: string,
  taskType: string,
  variants: Array<{ label: string; description: string; config: Record<string, unknown> }>,
): StrategyRecord {
  if (genome.strategies.length >= MAX_STRATEGIES) {
    const concluded = genome.strategies.filter(s => s.concluded)
    if (concluded.length > 0) {
      genome.strategies = genome.strategies.filter(s => s.id !== concluded[0].id)
    }
  }

  const strategy: StrategyRecord = {
    id: genId('exp'),
    name,
    taskType,
    variants: variants.map(v => ({
      ...v,
      successes: 0,
      failures: 0,
      totalTime: 0,
      samples: 0,
    })),
    sampleSize: 0,
    concluded: false,
    createdAt: Date.now(),
  }
  genome.strategies.push(strategy)
  genome.meta.experimentsRun++
  markGenomeDirty()
  return strategy
}

export function getStrategies(): StrategyRecord[] {
  return genome.strategies
}

export function findActiveStrategy(taskType: string): StrategyRecord | undefined {
  return genome.strategies.find(s => s.taskType === taskType && !s.concluded)
}

// ── Critic Rule Operations ─────────────────────────────────────

export function addCriticRule(
  condition: string,
  decision: 'approve' | 'deny',
  confidence: number,
  reason: string,
  source: string,
): CriticRule {
  if (genome.criticRules.length >= MAX_CRITIC_RULES) {
    const sorted = [...genome.criticRules].sort((a, b) => a.hitCount - b.hitCount)
    const victim = sorted[0]
    if (victim) {
      genome.criticRules = genome.criticRules.filter(r => r.id !== victim.id)
    }
  }

  const rule: CriticRule = {
    id: genId('cr'),
    condition,
    decision,
    confidence,
    reason,
    source,
    hitCount: 0,
    createdAt: Date.now(),
  }
  genome.criticRules.push(rule)
  markGenomeDirty()
  return rule
}

export function getCriticRules(): CriticRule[] {
  return genome.criticRules
}

// ── Constitution Operations ────────────────────────────────────

export function addConstitutionEntry(
  invariant: string,
  enforcement: 'structural' | 'checked',
  description: string,
): ConstitutionEntry {
  const entry: ConstitutionEntry = {
    id: genId('const'),
    invariant,
    enforcement,
    description,
    createdAt: Date.now(),
    immutable: true,
  }
  genome.constitution.push(entry)
  markGenomeDirty()
  return entry
}

export function getConstitution(): ConstitutionEntry[] {
  return genome.constitution
}

// ── Ratchet Test Operations ────────────────────────────────────

export function addRatchetTest(
  name: string,
  assertion: string,
  source: string,
): RatchetTest {
  if (genome.ratchetTests.length >= MAX_RATCHET_TESTS) {
    throw new Error(`Ratchet test suite at capacity (${MAX_RATCHET_TESTS}). Tests only grow.`)
  }

  const test: RatchetTest = {
    id: genId('rt'),
    name,
    assertion,
    source,
    createdAt: Date.now(),
  }
  genome.ratchetTests.push(test)
  markGenomeDirty()
  return test
}

export function getRatchetTests(): RatchetTest[] {
  return genome.ratchetTests
}

// ── Curriculum Operations ──────────────────────────────────────

export function updateTaskProfile(
  taskType: string,
  success: boolean,
  difficulty: number,
): void {
  const profile = genome.curriculum.taskTypes[taskType] ?? {
    successRate: 0,
    attempts: 0,
    difficulty,
    lastAttempt: 0,
    trend: [],
  }

  profile.attempts++
  profile.successRate =
    (profile.successRate * (profile.attempts - 1) + (success ? 1 : 0)) / profile.attempts
  profile.difficulty = difficulty
  profile.lastAttempt = Date.now()
  profile.trend.push(success ? 1 : 0)
  if (profile.trend.length > 50) profile.trend.shift()

  genome.curriculum.taskTypes[taskType] = profile
  markGenomeDirty()
}

export function getCurriculum(): CurriculumProfile {
  return genome.curriculum
}

export function getSweetSpotTasks(): Array<{ taskType: string; successRate: number }> {
  return Object.entries(genome.curriculum.taskTypes)
    .filter(([, p]) => p.successRate >= 0.4 && p.successRate <= 0.7 && p.attempts >= 5)
    .map(([taskType, p]) => ({ taskType, successRate: p.successRate }))
    .sort((a, b) => Math.abs(0.6 - a.successRate) - Math.abs(0.6 - b.successRate))
}

// ── Serialization ──────────────────────────────────────────────

export function exportGenome(): string {
  return JSON.stringify(genome, null, 2)
}

export function importGenome(json: string): void {
  const parsed = JSON.parse(json) as RsiGenome
  if (!parsed.version || !parsed.meta) {
    throw new Error('Invalid genome format')
  }
  genome = parsed
  reindexIdCounter()
  markGenomeDirty()
}

export function mergeAntibodies(foreign: Antibody[]): number {
  let imported = 0
  for (const ab of foreign) {
    const exists = genome.antibodies.find(
      a => a.pattern.tool === ab.pattern.tool &&
           a.pattern.errorPattern === ab.pattern.errorPattern,
    )
    if (!exists && genome.antibodies.length < MAX_ANTIBODIES) {
      genome.antibodies.push({ ...ab, id: genId('ab'), hitCount: 0, blockCount: 0 })
      imported++
    }
  }
  if (imported > 0) markGenomeDirty()
  return imported
}

// ── Stats ──────────────────────────────────────────────────────

export function getGenomeStats(): {
  antibodies: number
  crystals: number
  activeExperiments: number
  criticRules: number
  ratchetTests: number
  constitutionEntries: number
  generation: number
  totalImprovements: number
} {
  return {
    antibodies: genome.antibodies.length,
    crystals: genome.crystals.length,
    activeExperiments: genome.strategies.filter(s => !s.concluded).length,
    criticRules: genome.criticRules.length,
    ratchetTests: genome.ratchetTests.length,
    constitutionEntries: genome.constitution.length,
    generation: genome.meta.generation,
    totalImprovements: genome.meta.totalImprovements,
  }
}

// ── Reset ──────────────────────────────────────────────────────

export function resetGenome(): void {
  genome = createEmptyGenome()
  idCounter = 0
  markGenomeDirty()
}

// ── Persistence ────────────────────────────────────────────────
//
// The genome is the agent's learned behaviour — antibodies that caught real
// tool failures, crystallized tool sequences, curriculum profiles, critic
// rules. In memory it is worthless across sessions: every process starts from
// an empty genome, so a guard compiled on Monday does nothing on Tuesday and
// the loop never compounds. Persisting it is what turns the hook layer from a
// per-session experiment into experience that accumulates.
//
// It lives in the config home, not the repository (unlike lessons, see
// lessonStore.ts). A lesson is knowledge *about a codebase* and belongs in
// the diff; the genome is the agent's own behaviour and travels with the
// agent, not with any one project — an antibody against a recurring tool
// failure should apply in every checkout, not only the one it was learned in.
//
// Writes are debounced and atomic. Hook handlers mutate the genome in place
// (e.g. `ab.hitCount++` on a live antibody), so mutation sites call
// markGenomeDirty() rather than going through a setter; a short debounce
// coalesces the burst of edits one turn produces into a single write.

/** Where the genome is stored. Respects CLAUDE_CONFIG_DIR via the helper. */
export function getGenomeFile(): string {
  return join(configHomeDir(), 'rsi', 'genome.json')
}

/** Flag the genome as changed and schedule a coalesced flush. */
export function markGenomeDirty(): void {
  genomeDirty = true
  if (!genomePersistenceEnabled) return
  if (genomeFlushTimer) return
  genomeFlushTimer = setTimeout(() => {
    genomeFlushTimer = null
    void flushGenome()
  }, 250)
  // Never hold the process open just to write state.
  ;(genomeFlushTimer as { unref?: () => void }).unref?.()
}

/**
 * Write the genome now. Safe to call at any time; concurrent calls collapse
 * into a single writer and re-check the dirty flag on completion, so the last
 * mutation is never lost to a race with an in-flight write.
 */
export async function flushGenome(): Promise<void> {
  if (!genomePersistenceEnabled) return
  if (genomeFlushInFlight) {
    await genomeFlushInFlight
    if (genomeDirty) return flushGenome()
    return
  }
  if (!genomeDirty) return
  genomeFlushInFlight = (async () => {
    const path = getGenomeFile()
    const body = exportGenome()
    try {
      await mkdir(join(configHomeDir(), 'rsi'), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, `${body}\n`, 'utf-8')
      await rename(tmp, path)
      genomeDirty = false
    } catch {
      // A failed write must not crash a hook. The genome stays dirty; the
      // next mutation (or the next boot) tries again.
    }
  })()
  try {
    await genomeFlushInFlight
  } finally {
    genomeFlushInFlight = null
  }
  if (genomeDirty) return flushGenome()
}

let genomeFileReadTried = false

/**
 * Load the genome from disk once per process. Called at boot before plugins
 * register, so the hooks start from accumulated experience rather than empty.
 * A missing or corrupt file is an empty genome, not an error — the same
 * stance lessonStore takes, and for the same reason: a bad state file should
 * cost you your accumulated guards, not the whole session.
 */
export function initGenomePersistence(): Promise<void> {
  if (genomeLoadPromise) return genomeLoadPromise
  genomeLoadPromise = (async () => {
    genomeFileReadTried = true
    try {
      const raw = await readFile(getGenomeFile(), 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (isValidGenome(parsed)) {
        genome = parsed
        reindexIdCounter()
      }
    } catch {
      // No file yet, or unreadable: keep the empty genome.
    } finally {
      genomeLoaded = true
      genomeDirty = false
      genomePersistenceEnabled = true
    }
  })()
  return genomeLoadPromise
}

/** For tests: forget that a load has happened, so a fresh one can run. */
export function resetGenomePersistenceForTests(): void {
  genomeLoadPromise = null
  genomeLoaded = false
  genomeFileReadTried = false
  genomeDirty = false
  genomePersistenceEnabled = false
  if (genomeFlushTimer) {
    clearTimeout(genomeFlushTimer)
    genomeFlushTimer = null
  }
}

function isValidGenome(value: unknown): value is RsiGenome {
  if (!value || typeof value !== 'object') return false
  const g = value as Partial<RsiGenome>
  return (
    typeof g.version === 'number' &&
    Array.isArray(g.antibodies) &&
    Array.isArray(g.crystals) &&
    Array.isArray(g.strategies) &&
    Array.isArray(g.criticRules) &&
    Array.isArray(g.constitution) &&
    Array.isArray(g.ratchetTests) &&
    !!g.curriculum &&
    typeof g.curriculum === 'object' &&
    !!g.meta &&
    typeof g.meta === 'object'
  )
}

/**
 * Recompute the id counter from the ids present, so a genome loaded from disk
 * does not hand out an id that already exists (which would make two
 * antibodies indistinguishable to removeAntibody).
 */
function reindexIdCounter(): void {
  let max = 0
  const consider = (id: unknown) => {
    if (typeof id !== 'string') return
    const m = /_([0-9a-f]+)$/.exec(id)
    if (m) max = Math.max(max, parseInt(m[1], 16))
  }
  for (const ab of genome.antibodies) consider(ab.id)
  for (const c of genome.crystals) consider(c.id)
  for (const s of genome.strategies) consider(s.id)
  for (const r of genome.criticRules) consider(r.id)
  for (const c of genome.constitution) consider(c.id)
  for (const r of genome.ratchetTests) consider(r.id)
  idCounter = max
}

