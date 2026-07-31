/**
 * Autoresearch loop for MemoryTool retrieval.
 *
 * Usage:
 *   bun run src/tools/MemoryTool/eval/run.ts            # score the current config
 *   bun run src/tools/MemoryTool/eval/run.ts --verbose  # per-case pass/fail
 *   bun run src/tools/MemoryTool/eval/run.ts --search   # sweep, keep improvements
 *
 * The loop is coordinate descent over RANKING: propose one single-parameter
 * mutation, re-score, keep it only if the score strictly improves, otherwise
 * revert. Every trial is appended to CHANGELOG.md next to this file, so the
 * record of what was tried and rejected survives the session — the rejected
 * mutations are the useful half, since they are what stops the next person
 * from re-running the same experiment.
 *
 * Retrieval is exercised through the real MemoryStore against a temp
 * directory built from the corpus, not through a reimplementation of the
 * scorer. A harness that tests its own copy of the logic proves nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { MemoryStore } from '../MemoryStore.js'
import { RANKING, type RankingConfig } from '../ranking.js'
import { CORPUS } from './corpus.js'
import { evaluate, formatResult, type EvalResult } from './score.js'

const CHANGELOG = join(dirname(fileURLToPath(import.meta.url)), 'CHANGELOG.md')

/**
 * Materialize the corpus as real memory files so the eval goes through the
 * same parse → rank → slice path the tool uses in production.
 */
function buildCorpusDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memeval-'))
  for (const m of CORPUS) {
    const tags = m.tags?.length ? `tags: [${m.tags.join(', ')}]\n` : ''
    writeFileSync(
      join(dir, `${m.id}.md`),
      `---\nname: ${m.name}\ndescription: ${m.description}\ntype: ${m.type}\n${tags}---\n\n${m.content}\n`,
      'utf-8',
    )
  }
  return dir
}

async function scoreConfig(dir: string): Promise<EvalResult> {
  const store = new MemoryStore(dir)
  return evaluate(async query => {
    const hits = await store.searchMemories(query, undefined, 10)
    return hits.map(m => m.id)
  })
}

/**
 * One mutation: a parameter, and the values worth trying for it. Kept as a
 * flat list rather than a continuous optimizer because the search space is
 * tiny and a reader should be able to see every value that was considered.
 */
const SWEEP: Array<{ key: keyof RankingConfig; values: unknown[] }> = [
  { key: 'nameWeight', values: [4, 6, 8, 12, 16] },
  { key: 'tagWeight', values: [2, 3, 5, 8] },
  { key: 'descriptionWeight', values: [2, 4, 6, 8] },
  { key: 'contentWeight', values: [0.5, 1, 2, 3] },
  { key: 'overcomeFactor', values: [0.15, 0.35, 0.6, 1] },
  { key: 'minTermLength', values: [2, 3] },
  { key: 'cjkBigrams', values: [true, false] },
]

async function search(dir: string): Promise<void> {
  let best = await scoreConfig(dir)
  const started = new Date().toISOString()
  log(`\n## Sweep ${started}\n\nbaseline: ${formatResult(best)}\n`)
  console.log(`baseline  ${formatResult(best)}`)

  let improved = true
  let pass = 0
  // Repeat passes until a full pass changes nothing: a later parameter can
  // unlock a better value for an earlier one.
  while (improved && pass < 5) {
    improved = false
    pass++
    for (const { key, values } of SWEEP) {
      const original = RANKING[key]
      let bestValue = original
      for (const value of values) {
        if (value === original) continue
        ;(RANKING[key] as unknown) = value
        const result = await scoreConfig(dir)
        const delta = result.score - best.score
        const verdict = delta > 1e-9 ? 'KEEP' : 'revert'
        log(
          `- \`${key}\`: ${JSON.stringify(original)} → ${JSON.stringify(value)} · score ${result.score.toFixed(4)} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)}) · ${verdict}`,
        )
        console.log(
          `  ${key} = ${String(value).padEnd(6)} score ${result.score.toFixed(4)} ${verdict}`,
        )
        if (delta > 1e-9) {
          best = result
          bestValue = value as never
          improved = true
        }
      }
      ;(RANKING[key] as unknown) = bestValue
    }
  }

  console.log(`\nbest      ${formatResult(best)}`)
  console.log('config:', JSON.stringify(RANKING, null, 2))
  log(
    `\n**Result after ${pass} pass(es)**: ${formatResult(best)}\n\n\`\`\`json\n${JSON.stringify(RANKING, null, 2)}\n\`\`\`\n`,
  )
}

function log(line: string): void {
  try {
    appendFileSync(CHANGELOG, `${line}\n`, 'utf-8')
  } catch {
    // Changelog is a convenience, not a dependency of the run.
  }
}

const dir = buildCorpusDir()
try {
  if (process.argv.includes('--search')) {
    await search(dir)
  } else {
    const result = await scoreConfig(dir)
    console.log(formatResult(result, process.argv.includes('--verbose')))
    if (result.score < 1) process.exitCode = 0
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
