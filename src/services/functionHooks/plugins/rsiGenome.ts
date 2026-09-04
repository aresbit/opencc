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
}
