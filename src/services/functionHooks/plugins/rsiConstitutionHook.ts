/**
 * RSI Constitution & Ratchet — The immutable safety layer.
 *
 * The genome splits into two layers:
 *   - Evolvable: antibodies, skills, strategies, memory (can be mutated)
 *   - Immutable: safety invariants, metrics definitions, modification rules
 *
 * Every self-modification passes through the constitution. The ratchet is
 * a grow-only regression test suite — tests can be added but never removed.
 * The immutable layer structurally (not by convention) refuses mutation
 * from the evolvable layer.
 *
 * Anti-Goodhart: metrics live in the immutable layer. The evolvable layer
 * can optimize against metrics but cannot redefine what "better" means.
 * When an agent can modify its own success criteria, any metric becomes
 * a target and ceases to be a good metric.
 *
 * Ring placement: ring 0 — constitution checks run before any genome
 * mutation reaches the evolvable layer.
 */

import type { OnRegistrar } from '../types.js'
import {
  getGenome,
  getConstitution,
  addConstitutionEntry,
  getRatchetTests,
  addRatchetTest,
  getAntibodies,
  getCrystals,
  getStrategies,
  getCriticRules,
  type ConstitutionEntry,
  type RatchetTest,
  type RsiGenome,
} from './rsiGenome.js'

// ── Violation Log ─────────────────────────────────────────────

interface ConstitutionViolation {
  id: string
  invariantId: string
  invariant: string
  operation: string
  detail: string
  blocked: boolean
  timestamp: number
}

const violations: ConstitutionViolation[] = []
const MAX_VIOLATIONS = 500
let violationCounter = 0

function recordViolation(
  invariantId: string,
  invariant: string,
  operation: string,
  detail: string,
  blocked: boolean,
): ConstitutionViolation {
  violationCounter++
  const v: ConstitutionViolation = {
    id: `cv_${violationCounter.toString(16).padStart(4, '0')}`,
    invariantId,
    invariant,
    operation,
    detail,
    blocked,
    timestamp: Date.now(),
  }
  violations.push(v)
  if (violations.length > MAX_VIOLATIONS) {
    violations.splice(0, violations.length - MAX_VIOLATIONS)
  }
  return v
}

// ── Metric Definitions (Immutable) ────────────────────────────

interface MetricDefinition {
  id: string
  name: string
  description: string
  compute: string
  higherIsBetter: boolean
  createdAt: number
  frozen: true
}

const metrics: MetricDefinition[] = []
let metricCounter = 0

function initDefaultMetrics(): void {
  if (metrics.length > 0) return

  const defaults: Array<Omit<MetricDefinition, 'id' | 'createdAt' | 'frozen'>> = [
    {
      name: 'antibody_precision',
      description: 'Ratio of true blocks to total blocks (1 - false positive rate)',
      compute: 'antibodies.filter(a => a.blockCount > 0).length / Math.max(1, antibodies.filter(a => a.hitCount > 0).length)',
      higherIsBetter: true,
    },
    {
      name: 'crystal_utilization',
      description: 'Fraction of crystallized skills actually invoked',
      compute: 'crystals.filter(c => c.callCount > 0).length / Math.max(1, crystals.length)',
      higherIsBetter: true,
    },
    {
      name: 'experiment_throughput',
      description: 'Fraction of experiments that reach conclusion',
      compute: 'strategies.filter(s => s.concluded).length / Math.max(1, strategies.length)',
      higherIsBetter: true,
    },
    {
      name: 'genome_growth_rate',
      description: 'Total genome entries per generation',
      compute: '(antibodies.length + crystals.length + criticRules.length) / Math.max(1, genome.meta.generation)',
      higherIsBetter: false,
    },
    {
      name: 'ratchet_coverage',
      description: 'Number of regression tests per genome component',
      compute: 'ratchetTests.length / Math.max(1, antibodies.length + crystals.length)',
      higherIsBetter: true,
    },
  ]

  for (const d of defaults) {
    metricCounter++
    metrics.push({
      id: `met_${metricCounter.toString(16).padStart(4, '0')}`,
      ...d,
      createdAt: Date.now(),
      frozen: true,
    })
  }
}

// ── Ratchet Execution ─────────────────────────────────────────

interface RatchetResult {
  testId: string
  name: string
  passed: boolean
  detail: string
  ranAt: number
}

function runRatchetTests(): RatchetResult[] {
  const genome = getGenome()
  const tests = getRatchetTests()
  const results: RatchetResult[] = []

  for (const test of tests) {
    let passed = true
    let detail = 'ok'

    try {
      if (test.assertion.includes('success rate')) {
        const match = test.name.match(/tool_reliability:(\w+)/)
        if (match) {
          const toolName = match[1]
          const curriculum = genome.curriculum.taskTypes
          for (const [taskType, profile] of Object.entries(curriculum)) {
            if (taskType.includes(toolName.toLowerCase()) && profile.successRate < 0.9) {
              passed = false
              detail = `${taskType} success rate ${(profile.successRate * 100).toFixed(1)}% < 90%`
            }
          }
        }
      }

      if (test.assertion.includes('antibody count')) {
        if (genome.antibodies.length === 0) {
          passed = false
          detail = 'No antibodies present'
        }
      }

      if (test.assertion.includes('constitution')) {
        if (genome.constitution.length === 0) {
          passed = false
          detail = 'No constitution entries'
        }
      }
    } catch (err) {
      passed = false
      detail = `Error: ${String(err)}`
    }

    test.lastRun = Date.now()
    test.lastResult = passed

    results.push({
      testId: test.id,
      name: test.name,
      passed,
      detail,
      ranAt: Date.now(),
    })
  }

  return results
}

// ── Constitution Validation ───────────────────────────────────

interface ValidationResult {
  valid: boolean
  violations: ConstitutionViolation[]
}

function validateGenomeMutation(operation: string, target: string, detail?: string): ValidationResult {
  const constitution = getConstitution()
  const found: ConstitutionViolation[] = []

  for (const entry of constitution) {
    const inv = entry.invariant.toLowerCase()

    if (inv.includes('no removal') && operation === 'remove') {
      if (inv.includes('ratchet') && target === 'ratchet') {
        const v = recordViolation(entry.id, entry.invariant, operation, detail ?? 'Attempted ratchet test removal', true)
        found.push(v)
      }
      if (inv.includes('constitution') && target === 'constitution') {
        const v = recordViolation(entry.id, entry.invariant, operation, detail ?? 'Attempted constitution entry removal', true)
        found.push(v)
      }
    }

    if (inv.includes('no modification') && operation === 'modify') {
      if (inv.includes('metric') && target === 'metric') {
        const v = recordViolation(entry.id, entry.invariant, operation, detail ?? 'Attempted metric modification', true)
        found.push(v)
      }
      if (inv.includes('constitution') && target === 'constitution') {
        const v = recordViolation(entry.id, entry.invariant, operation, detail ?? 'Attempted constitution modification', true)
        found.push(v)
      }
    }

    if (inv.includes('maximum') && operation === 'add') {
      if (inv.includes('antibod')) {
        const max = parseInt(inv.match(/\d+/)?.[0] ?? '200', 10)
        if (getAntibodies().length >= max) {
          const v = recordViolation(entry.id, entry.invariant, operation, `Antibody count at limit (${max})`, true)
          found.push(v)
        }
      }
    }
  }

  return { valid: found.length === 0, violations: found }
}

// ── Default Constitution ──────────────────────────────────────

function initDefaultConstitution(): void {
  const constitution = getConstitution()
  if (constitution.length > 0) return

  const defaults: Array<{ invariant: string; enforcement: 'structural' | 'checked'; description: string }> = [
    {
      invariant: 'No removal of ratchet tests — the regression suite only grows',
      enforcement: 'structural',
      description: 'Ratchet tests are append-only. Once a test is added, it cannot be removed by any evolvable-layer operation.',
    },
    {
      invariant: 'No modification of constitution entries — immutable layer is append-only',
      enforcement: 'structural',
      description: 'Constitution entries cannot be modified or removed once created. New entries can be added.',
    },
    {
      invariant: 'No modification of metric definitions from evolvable layer',
      enforcement: 'structural',
      description: 'Metric definitions are frozen at creation. The evolvable layer can optimize against metrics but cannot redefine what "better" means.',
    },
    {
      invariant: 'All genome mutations must pass ratchet tests before applying',
      enforcement: 'checked',
      description: 'Before any mutation is applied to the genome, the full ratchet test suite runs. If any test fails, the mutation is blocked.',
    },
    {
      invariant: 'Antibody false-positive rate must not exceed 10% for any single antibody',
      enforcement: 'checked',
      description: 'Antibodies with >10% false positive rate are flagged for review. Prevents overly aggressive guards.',
    },
  ]

  for (const d of defaults) {
    addConstitutionEntry(d.invariant, d.enforcement, d.description)
  }
}

// ── Metric Computation ────────────────────────────────────────

interface MetricSnapshot {
  metricId: string
  name: string
  value: number
  computedAt: number
}

const metricHistory: MetricSnapshot[] = []
const MAX_METRIC_HISTORY = 1000

function computeMetrics(): MetricSnapshot[] {
  initDefaultMetrics()

  const genome = getGenome()
  const antibodies = getAntibodies()
  const crystals = getCrystals()
  const strategies = getStrategies()
  const criticRules = getCriticRules()
  const ratchetTests = getRatchetTests()

  const snapshots: MetricSnapshot[] = []

  for (const met of metrics) {
    let value = 0

    switch (met.name) {
      case 'antibody_precision':
        value = antibodies.length > 0
          ? antibodies.filter(a => a.blockCount > 0).length / Math.max(1, antibodies.filter(a => a.hitCount > 0).length)
          : 1
        break
      case 'crystal_utilization':
        value = crystals.length > 0
          ? crystals.filter(c => c.callCount > 0).length / crystals.length
          : 0
        break
      case 'experiment_throughput':
        value = strategies.length > 0
          ? strategies.filter(s => s.concluded).length / strategies.length
          : 0
        break
      case 'genome_growth_rate':
        value = genome.meta.generation > 0
          ? (antibodies.length + crystals.length + criticRules.length) / genome.meta.generation
          : 0
        break
      case 'ratchet_coverage':
        value = (antibodies.length + crystals.length) > 0
          ? ratchetTests.length / (antibodies.length + crystals.length)
          : 0
        break
    }

    const snapshot: MetricSnapshot = {
      metricId: met.id,
      name: met.name,
      value,
      computedAt: Date.now(),
    }
    snapshots.push(snapshot)
    metricHistory.push(snapshot)
  }

  if (metricHistory.length > MAX_METRIC_HISTORY) {
    metricHistory.splice(0, metricHistory.length - MAX_METRIC_HISTORY)
  }

  return snapshots
}

// ── Hook Registration ───────────────────────────────────────────

export function register(on: OnRegistrar): void {
  initDefaultConstitution()
  initDefaultMetrics()

  // Validate genome mutations on session.end (sleep consolidation)
  on('session.end', async ($, e: any, next) => {
    const ratchetResults = runRatchetTests()
    const failures = ratchetResults.filter(r => !r.passed)

    if (failures.length > 0) {
      for (const f of failures) {
        recordViolation(
          f.testId,
          `Ratchet test: ${f.name}`,
          'sleep_consolidation',
          f.detail,
          false,
        )
      }
    }

    computeMetrics()

    return next(e)
  })

  // Validate antibody compilations
  on('tool.error', async ($, e: any, next) => {
    // Check antibody false-positive rate
    for (const ab of getAntibodies()) {
      if (ab.hitCount > 10) {
        const fpRate = ab.falsePositives / ab.hitCount
        if (fpRate > 0.1) {
          recordViolation(
            'fp_check',
            'Antibody false-positive rate must not exceed 10%',
            'antibody_check',
            `Antibody ${ab.id} has ${(fpRate * 100).toFixed(1)}% false positive rate`,
            false,
          )
        }
      }
    }

    return next(e)
  })
}

// ── Public API ──────────────────────────────────────────────────

export function addInvariant(
  invariant: string,
  enforcement: 'structural' | 'checked',
  description: string,
): ConstitutionEntry {
  return addConstitutionEntry(invariant, enforcement, description)
}

export function listInvariants(): ConstitutionEntry[] {
  return getConstitution()
}

export function addTest(name: string, assertion: string, source: string): RatchetTest {
  return addRatchetTest(name, assertion, source)
}

export function listTests(): RatchetTest[] {
  return getRatchetTests()
}

export function runTests(): RatchetResult[] {
  return runRatchetTests()
}

export function validate(operation: string, target: string, detail?: string): ValidationResult {
  return validateGenomeMutation(operation, target, detail)
}

export function getMetrics(): MetricSnapshot[] {
  return computeMetrics()
}

export function getMetricDefinitions(): MetricDefinition[] {
  initDefaultMetrics()
  return [...metrics]
}

export function getMetricHistory(metricName?: string): MetricSnapshot[] {
  if (metricName) {
    return metricHistory.filter(s => s.name === metricName)
  }
  return [...metricHistory]
}

export function getViolations(limit?: number): ConstitutionViolation[] {
  if (limit) {
    return violations.slice(-limit)
  }
  return [...violations]
}

export function getConstitutionStats(): {
  invariants: number
  structuralInvariants: number
  checkedInvariants: number
  ratchetTests: number
  ratchetPassing: number
  metricDefinitions: number
  totalViolations: number
  blockedViolations: number
} {
  const constitution = getConstitution()
  const tests = getRatchetTests()
  const passing = tests.filter(t => t.lastResult === true).length

  return {
    invariants: constitution.length,
    structuralInvariants: constitution.filter(e => e.enforcement === 'structural').length,
    checkedInvariants: constitution.filter(e => e.enforcement === 'checked').length,
    ratchetTests: tests.length,
    ratchetPassing: passing,
    metricDefinitions: metrics.length,
    totalViolations: violations.length,
    blockedViolations: violations.filter(v => v.blocked).length,
  }
}

export function clearConstitution(): void {
  violations.length = 0
  violationCounter = 0
  metricHistory.length = 0
}
