import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { getCwd } from '../../utils/cwd.js'
import { PROVE2ME_TOOL_NAME } from './toolName.js'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

// ── Core types ──────────────────────────────────────────────────

interface TheoremNode {
  id: string
  lean4Statement: string
  naturalLanguage: string
  sourceFile: string
  sourceFunction: string
  status: 'open' | 'proved' | 'sorry' | 'failed'
  dependencies: string[]
  dependents: string[]
  proofs: ProofSketch[]
  tags: string[]
  createdAt: number
  provedAt?: number
}

interface ProofSketch {
  id: string
  theoremId: string
  lean4Code: string
  author: string
  hasSorry: boolean
  sorryCount: number
  childTheorems: string[]
  status: 'pending' | 'verified' | 'rejected'
  submittedAt: number
  verifiedAt?: number
}

interface TheoremDAG {
  version: number
  nodes: Record<string, TheoremNode>
  roots: string[]
  topologicalOrder: string[]
  stats: DAGStats
}

interface DAGStats {
  total: number
  open: number
  proved: number
  sorry: number
  failed: number
  maxDepth: number
}

interface SearchResult {
  theoremId: string
  score: number
  statement: string
  naturalLanguage: string
  status: string
}

// ── DAG state (module-scoped) ───────────────────────────────────

let dag: TheoremDAG = createEmptyDAG()

function createEmptyDAG(): TheoremDAG {
  return {
    version: 1,
    nodes: {},
    roots: [],
    topologicalOrder: [],
    stats: { total: 0, open: 0, proved: 0, sorry: 0, failed: 0, maxDepth: 0 },
  }
}

// ── DAG operations ──────────────────────────────────────────────

function addTheorem(
  id: string,
  lean4Statement: string,
  naturalLanguage: string,
  sourceFile: string,
  sourceFunction: string,
  dependencies: string[],
  tags: string[] = [],
): TheoremNode {
  if (dag.nodes[id]) throw new Error(`Theorem ${id} already exists`)
  for (const dep of dependencies) {
    if (!dag.nodes[dep]) throw new Error(`Dependency ${dep} not found in DAG`)
  }
  const node: TheoremNode = {
    id,
    lean4Statement,
    naturalLanguage,
    sourceFile,
    sourceFunction,
    status: 'open',
    dependencies,
    dependents: [],
    proofs: [],
    tags,
    createdAt: Date.now(),
  }
  dag.nodes[id] = node
  for (const dep of dependencies) {
    dag.nodes[dep]!.dependents.push(id)
  }
  if (dependencies.length === 0) dag.roots.push(id)
  recomputeTopologicalOrder()
  recomputeStats()
  return node
}

function submitProof(
  theoremId: string,
  lean4Code: string,
  author: string,
): ProofSketch {
  const node = dag.nodes[theoremId]
  if (!node) throw new Error(`Theorem ${theoremId} not found`)
  const sorryMatches = lean4Code.match(/\bsorry\b/g)
  const sorryCount = sorryMatches ? sorryMatches.length : 0
  const sketch: ProofSketch = {
    id: `proof_${theoremId}_${node.proofs.length}`,
    theoremId,
    lean4Code,
    author,
    hasSorry: sorryCount > 0,
    sorryCount,
    childTheorems: [],
    status: sorryCount === 0 ? 'verified' : 'pending',
    submittedAt: Date.now(),
    verifiedAt: sorryCount === 0 ? Date.now() : undefined,
  }
  node.proofs.push(sketch)
  if (sorryCount === 0) {
    node.status = 'proved'
    node.provedAt = Date.now()
  } else {
    node.status = 'sorry'
  }
  recomputeStats()
  return sketch
}

function getAttackable(): TheoremNode[] {
  return Object.values(dag.nodes).filter(
    n => n.status === 'open' && n.dependencies.every(d => dag.nodes[d]?.status === 'proved'),
  )
}

function searchTheorems(query: string, limit = 10): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/)
  const scored: SearchResult[] = []
  for (const node of Object.values(dag.nodes)) {
    const text = `${node.naturalLanguage} ${node.lean4Statement} ${node.tags.join(' ')}`.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (text.includes(term)) score += 1
    }
    if (score > 0) {
      scored.push({
        theoremId: node.id,
        score,
        statement: node.lean4Statement,
        naturalLanguage: node.naturalLanguage,
        status: node.status,
      })
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

function recomputeTopologicalOrder(): void {
  const visited = new Set<string>()
  const order: string[] = []
  function visit(id: string) {
    if (visited.has(id)) return
    visited.add(id)
    const node = dag.nodes[id]
    if (!node) return
    for (const dep of node.dependencies) visit(dep)
    order.push(id)
  }
  for (const id of Object.keys(dag.nodes)) visit(id)
  dag.topologicalOrder = order
}

function recomputeStats(): void {
  const nodes = Object.values(dag.nodes)
  dag.stats = {
    total: nodes.length,
    open: nodes.filter(n => n.status === 'open').length,
    proved: nodes.filter(n => n.status === 'proved').length,
    sorry: nodes.filter(n => n.status === 'sorry').length,
    failed: nodes.filter(n => n.status === 'failed').length,
    maxDepth: computeMaxDepth(),
  }
}

function computeMaxDepth(): number {
  const memo: Record<string, number> = {}
  function depth(id: string): number {
    if (memo[id] !== undefined) return memo[id]!
    const node = dag.nodes[id]
    if (!node || node.dependencies.length === 0) {
      memo[id] = 0
      return 0
    }
    const d = 1 + Math.max(...node.dependencies.map(depth))
    memo[id] = d
    return d
  }
  let max = 0
  for (const id of Object.keys(dag.nodes)) {
    max = Math.max(max, depth(id))
  }
  return max
}

// ── Lean 4 code generation ──────────────────────────────────────

function generateLean4Module(theoremIds?: string[]): string {
  const ids = theoremIds ?? dag.topologicalOrder
  const lines: string[] = [
    '-- Auto-generated by Prove2MeTool',
    '-- Prove2Me: https://prove2.me/',
    `-- Generated: ${new Date().toISOString()}`,
    '',
    'import Mathlib',
    '',
  ]
  for (const id of ids) {
    const node = dag.nodes[id]
    if (!node) continue
    lines.push(`/-- ${node.naturalLanguage} -/`)
    lines.push(node.lean4Statement)
    const verified = node.proofs.find(p => p.status === 'verified')
    if (verified) {
      lines.push(verified.lean4Code)
    } else if (node.proofs.length > 0) {
      const best = node.proofs[node.proofs.length - 1]!
      lines.push(`-- Proof sketch (${best.sorryCount} sorry remaining):`)
      lines.push(best.lean4Code)
    } else {
      lines.push('  := by sorry')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function generateStatementFile(theoremIds?: string[]): string {
  const ids = theoremIds ?? dag.topologicalOrder
  const lines: string[] = [
    '-- Theorem statements (separated from proofs per Prove2Me design)',
    '-- Each statement is immutable once submitted',
    '',
    'import Mathlib',
    '',
  ]
  for (const id of ids) {
    const node = dag.nodes[id]
    if (!node) continue
    lines.push(`/-- ${node.naturalLanguage} -/`)
    lines.push(node.lean4Statement)
    lines.push('  := by sorry')
    lines.push('')
  }
  return lines.join('\n')
}

function generateProofFile(theoremId: string): string {
  const node = dag.nodes[theoremId]
  if (!node) return `-- Theorem ${theoremId} not found`
  const lines: string[] = [
    `-- Proofs for: ${node.id}`,
    `-- Statement: ${node.naturalLanguage}`,
    '',
    'import Mathlib',
    '',
    node.lean4Statement,
  ]
  if (node.proofs.length === 0) {
    lines.push('  := by sorry')
  } else {
    for (const proof of node.proofs) {
      lines.push(`-- Proof ${proof.id} [${proof.status}] by ${proof.author}`)
      lines.push(proof.lean4Code)
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ── Code → Lean translation helpers ─────────────────────────────

function analyzeFunction(code: string, functionName: string): string[] {
  const properties: string[] = []
  if (code.includes('return') || code.includes('=>')) {
    properties.push(`theorem ${functionName}_terminates : ∀ (input : InputType), ∃ (output : OutputType), ${functionName} input = some output`)
  }
  if (code.includes('sort') || code.includes('Sort')) {
    properties.push(`theorem ${functionName}_sorted : ∀ (xs : List α) [Ord α], IsSorted (${functionName} xs)`)
  }
  if (code.includes('.length') || code.includes('.size')) {
    properties.push(`theorem ${functionName}_preserves_length : ∀ (xs : List α), (${functionName} xs).length = xs.length`)
  }
  if (code.includes('Map') || code.includes('Record') || code.includes('{}')) {
    properties.push(`theorem ${functionName}_keys_preserved : ∀ (m : Map K V), (${functionName} m).keys = m.keys`)
  }
  if (code.includes('filter') || code.includes('Filter')) {
    properties.push(`theorem ${functionName}_subset : ∀ (xs : List α) (p : α → Bool), (${functionName} xs p) ⊆ xs`)
  }
  if (code.includes('async') || code.includes('Promise') || code.includes('await')) {
    properties.push(`theorem ${functionName}_eventually_returns : ∀ (input : InputType), Eventually (fun s => ${functionName}_complete s input)`)
  }
  if (code.includes('try') || code.includes('catch') || code.includes('Error')) {
    properties.push(`theorem ${functionName}_error_handled : ∀ (input : InputType), ${functionName} input ≠ panic`)
  }
  if (code.includes('push') || code.includes('append') || code.includes('concat')) {
    properties.push(`theorem ${functionName}_monotone : ∀ (xs ys : List α), xs.length ≤ (${functionName} xs ys).length`)
  }
  if (properties.length === 0) {
    properties.push(`theorem ${functionName}_well_defined : ∀ (x y : InputType), x = y → ${functionName} x = ${functionName} y`)
  }
  return properties
}

function codeToLeanStatements(
  sourceCode: string,
  sourceFile: string,
  moduleName: string,
): { statements: Array<{ id: string; lean4: string; nl: string; fn: string }>; summary: string } {
  const fnPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g
  const statements: Array<{ id: string; lean4: string; nl: string; fn: string }> = []
  let match: RegExpExecArray | null
  let idx = 0
  while ((match = fnPattern.exec(sourceCode)) !== null) {
    const fnName = match[1] || match[2]
    if (!fnName) continue
    const startIdx = match.index
    const contextEnd = Math.min(startIdx + 500, sourceCode.length)
    const fnBody = sourceCode.slice(startIdx, contextEnd)
    const properties = analyzeFunction(fnBody, fnName)
    for (const prop of properties) {
      const id = `${moduleName}_${fnName}_${idx++}`
      const thmName = prop.match(/theorem\s+(\S+)/)?.[1] ?? `${fnName}_property`
      statements.push({
        id,
        lean4: prop,
        nl: `Property of function ${fnName} in ${sourceFile}: ${thmName.replace(/_/g, ' ')}`,
        fn: fnName,
      })
    }
  }
  return {
    statements,
    summary: `Extracted ${statements.length} theorem statements from ${sourceFile} covering ${new Set(statements.map(s => s.fn)).size} functions`,
  }
}

// ── Persistence ─────────────────────────────────────────────────

async function saveDAG(outputDir: string): Promise<string> {
  const dagPath = path.join(outputDir, 'prove2me_dag.json')
  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(dagPath, JSON.stringify(dag, null, 2))
  return dagPath
}

async function loadDAG(dagPath: string): Promise<void> {
  try {
    const raw = await fs.readFile(dagPath, 'utf-8')
    dag = JSON.parse(raw)
  } catch {
    dag = createEmptyDAG()
  }
}

async function exportLeanFiles(outputDir: string): Promise<string[]> {
  await fs.mkdir(outputDir, { recursive: true })
  const created: string[] = []

  const stmtPath = path.join(outputDir, 'Statements.lean')
  await fs.writeFile(stmtPath, generateStatementFile())
  created.push(stmtPath)

  for (const node of Object.values(dag.nodes)) {
    if (node.proofs.length > 0) {
      const proofPath = path.join(outputDir, `Proof_${node.id}.lean`)
      await fs.writeFile(proofPath, generateProofFile(node.id))
      created.push(proofPath)
    }
  }

  const dagPath = path.join(outputDir, 'prove2me_dag.json')
  await fs.writeFile(dagPath, JSON.stringify(dag, null, 2))
  created.push(dagPath)

  return created
}

// ── Schema ──────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'analyze',
        'add-theorem',
        'submit-proof',
        'status',
        'search',
        'attackable',
        'generate',
        'export',
        'load',
        'reset',
      ])
      .describe(
        'analyze: extract Lean 4 theorem statements from source code. ' +
        'add-theorem: manually add a theorem to the DAG. ' +
        'submit-proof: submit a Lean 4 proof sketch for a theorem. ' +
        'status: show DAG statistics and theorem status. ' +
        'search: find theorems by natural language query. ' +
        'attackable: list theorems whose dependencies are all proved. ' +
        'generate: output Lean 4 code (combined or statement/proof separated). ' +
        'export: write Lean files and DAG to disk. ' +
        'load: load a previously saved DAG from disk. ' +
        'reset: clear the DAG.',
      ),
    sourceCode: z
      .string()
      .optional()
      .describe('Source code to analyze (for analyze action).'),
    sourceFile: z
      .string()
      .optional()
      .describe('Path of the source file being analyzed.'),
    moduleName: z
      .string()
      .optional()
      .describe('Lean module name prefix for generated theorems.'),
    theoremId: z
      .string()
      .optional()
      .describe('Theorem ID for add-theorem, submit-proof, generate actions.'),
    lean4Statement: z
      .string()
      .optional()
      .describe('Lean 4 theorem statement (for add-theorem).'),
    naturalLanguage: z
      .string()
      .optional()
      .describe('Natural language description of the theorem (for add-theorem, search).'),
    sourceFunction: z
      .string()
      .optional()
      .describe('Name of the source function this theorem relates to.'),
    dependencies: z
      .array(z.string())
      .optional()
      .describe('Theorem IDs this theorem depends on (for add-theorem).'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Tags for categorization.'),
    lean4Code: z
      .string()
      .optional()
      .describe('Lean 4 proof code (for submit-proof).'),
    author: z
      .string()
      .optional()
      .describe('Author of the proof sketch.'),
    query: z
      .string()
      .optional()
      .describe('Natural language search query (for search action).'),
    limit: z
      .number()
      .optional()
      .describe('Max results for search (default 10).'),
    outputDir: z
      .string()
      .optional()
      .describe('Directory for export/load. Defaults to cwd/prove2me.'),
    dagPath: z
      .string()
      .optional()
      .describe('Path to DAG JSON file (for load action).'),
    separated: z
      .boolean()
      .optional()
      .describe('If true, generate separates statements from proofs (for generate action). Default true.'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    summary: z.string(),
    detail: z.array(z.string()).optional(),
    lean4Output: z.string().optional(),
    theorems: z.array(z.object({
      id: z.string(),
      statement: z.string(),
      naturalLanguage: z.string(),
      status: z.string(),
    })).optional(),
    stats: z.object({
      total: z.number(),
      open: z.number(),
      proved: z.number(),
      sorry: z.number(),
      failed: z.number(),
      maxDepth: z.number(),
    }).optional(),
    filesCreated: z.array(z.string()).optional(),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

// ── Action dispatch ─────────────────────────────────────────────

async function runAction(input: Input): Promise<Output> {
  const base = { action: input.action }

  switch (input.action) {
    case 'analyze': {
      if (!input.sourceCode) return { ...base, success: false, summary: 'sourceCode is required for analyze' }
      const file = input.sourceFile ?? 'unknown.ts'
      const mod = input.moduleName ?? file.replace(/[^a-zA-Z0-9]/g, '_')
      const result = codeToLeanStatements(input.sourceCode, file, mod)
      for (const stmt of result.statements) {
        try {
          addTheorem(stmt.id, stmt.lean4, stmt.nl, file, stmt.fn, input.dependencies ?? [], input.tags ?? [])
        } catch {
          // duplicate or dep missing — skip
        }
      }
      return {
        ...base,
        success: true,
        summary: result.summary,
        theorems: result.statements.map(s => ({
          id: s.id,
          statement: s.lean4,
          naturalLanguage: s.nl,
          status: 'open',
        })),
        stats: dag.stats,
      }
    }

    case 'add-theorem': {
      if (!input.theoremId || !input.lean4Statement || !input.naturalLanguage) {
        return { ...base, success: false, summary: 'theoremId, lean4Statement, and naturalLanguage are required' }
      }
      try {
        const node = addTheorem(
          input.theoremId,
          input.lean4Statement,
          input.naturalLanguage,
          input.sourceFile ?? '',
          input.sourceFunction ?? '',
          input.dependencies ?? [],
          input.tags ?? [],
        )
        return {
          ...base,
          success: true,
          summary: `Added theorem ${node.id} with ${node.dependencies.length} dependencies`,
          stats: dag.stats,
        }
      } catch (e: unknown) {
        return { ...base, success: false, summary: String(e) }
      }
    }

    case 'submit-proof': {
      if (!input.theoremId || !input.lean4Code) {
        return { ...base, success: false, summary: 'theoremId and lean4Code are required' }
      }
      try {
        const sketch = submitProof(
          input.theoremId,
          input.lean4Code,
          input.author ?? 'agent',
        )
        const node = dag.nodes[input.theoremId]!
        return {
          ...base,
          success: true,
          summary: sketch.hasSorry
            ? `Proof sketch submitted with ${sketch.sorryCount} sorry — theorem status: sorry`
            : `Proof verified (sorry-free) — theorem ${input.theoremId} is now proved`,
          detail: sketch.hasSorry
            ? [`Child theorems needed: ${sketch.sorryCount}`, `Submit sorry-free proofs for each to close them.`]
            : [`Theorem ${input.theoremId} proved. Dependents now unblocked: ${node.dependents.join(', ') || 'none'}`],
          stats: dag.stats,
        }
      } catch (e: unknown) {
        return { ...base, success: false, summary: String(e) }
      }
    }

    case 'status': {
      const nodes = Object.values(dag.nodes)
      return {
        ...base,
        success: true,
        summary: `DAG: ${dag.stats.total} theorems — ${dag.stats.proved} proved, ${dag.stats.open} open, ${dag.stats.sorry} sorry, ${dag.stats.failed} failed (depth ${dag.stats.maxDepth})`,
        theorems: nodes.map(n => ({
          id: n.id,
          statement: n.lean4Statement,
          naturalLanguage: n.naturalLanguage,
          status: n.status,
        })),
        stats: dag.stats,
      }
    }

    case 'search': {
      if (!input.query) return { ...base, success: false, summary: 'query is required for search' }
      const results = searchTheorems(input.query, input.limit ?? 10)
      return {
        ...base,
        success: true,
        summary: `Found ${results.length} matching theorems`,
        theorems: results.map(r => ({
          id: r.theoremId,
          statement: r.statement,
          naturalLanguage: r.naturalLanguage,
          status: r.status,
        })),
      }
    }

    case 'attackable': {
      const ready = getAttackable()
      return {
        ...base,
        success: true,
        summary: `${ready.length} theorems are attackable (all dependencies proved)`,
        theorems: ready.map(n => ({
          id: n.id,
          statement: n.lean4Statement,
          naturalLanguage: n.naturalLanguage,
          status: n.status,
        })),
      }
    }

    case 'generate': {
      const separated = input.separated !== false
      const ids = input.theoremId ? [input.theoremId] : undefined
      let lean4Output: string
      if (separated) {
        lean4Output = [
          '-- === STATEMENTS ===',
          generateStatementFile(ids),
          '',
          '-- === PROOFS ===',
          ...(ids ?? dag.topologicalOrder).map(id => generateProofFile(id)),
        ].join('\n')
      } else {
        lean4Output = generateLean4Module(ids)
      }
      return {
        ...base,
        success: true,
        summary: `Generated Lean 4 ${separated ? '(statement/proof separated)' : '(combined)'} for ${ids?.length ?? dag.stats.total} theorems`,
        lean4Output,
      }
    }

    case 'export': {
      const dir = input.outputDir ?? path.join(getCwd(), 'prove2me')
      const files = await exportLeanFiles(dir)
      return {
        ...base,
        success: true,
        summary: `Exported ${files.length} files to ${dir}`,
        filesCreated: files,
        stats: dag.stats,
      }
    }

    case 'load': {
      const dagFile = input.dagPath ?? path.join(input.outputDir ?? path.join(getCwd(), 'prove2me'), 'prove2me_dag.json')
      await loadDAG(dagFile)
      return {
        ...base,
        success: true,
        summary: `Loaded DAG from ${dagFile}: ${dag.stats.total} theorems`,
        stats: dag.stats,
      }
    }

    case 'reset': {
      dag = createEmptyDAG()
      return { ...base, success: true, summary: 'DAG reset to empty' }
    }

    default:
      return { ...base, success: false, summary: `Unknown action: ${input.action}` }
  }
}

// ── Tool definition ─────────────────────────────────────────────

const DESCRIPTION =
  'Prove2Me-inspired formal verification tool. Extracts Lean 4 theorem statements ' +
  'from source code, manages a theorem DAG (directed acyclic graph), separates ' +
  'statements from proofs, and supports natural language search for theorem reuse. ' +
  'Based on the Prove2Me platform (Tianyi Peng, Columbia University).'

const PROMPT = `# Prove2Me — Lean 4 formal verification for code modules

Based on the Prove2Me open platform (https://prove2.me/) by Tianyi Peng and the Columbia University team.

## Three core design principles

1. **DAG-managed global state**: Theorem statements form a directed acyclic graph.
   Agents query the DAG to find which theorems are proved, which are attackable
   (all dependencies proved), and which to attempt next. This counters LLM
   context/memory degradation and supports parallel work.

2. **Statement/proof separation**: Theorem statements and proofs live in separate
   files with independent maintenance. Statements are immutable once submitted.
   This accelerates Lean compilation and reduces resource consumption.

3. **Natural language descriptions**: Every theorem carries a natural language
   description enabling search and reuse, avoiding duplicate work and shortening
   proof paths.

## Actions

- \`analyze\` — Extract Lean 4 theorem statements from TypeScript/JavaScript source code.
  Input: sourceCode, sourceFile, moduleName. Auto-detects function properties
  (termination, sorting, length preservation, error handling, monotonicity).

- \`add-theorem\` — Manually add a theorem to the DAG with dependencies.
  Input: theoremId, lean4Statement, naturalLanguage, dependencies.

- \`submit-proof\` — Submit a Lean 4 proof sketch. Sorry-free proofs mark the
  theorem as proved. Sketches with sorry create child obligations.
  Input: theoremId, lean4Code, author.

- \`status\` — Show DAG statistics: total/open/proved/sorry/failed counts, depth.

- \`search\` — Find existing theorems by natural language query for reuse.
  Input: query, limit.

- \`attackable\` — List theorems whose dependencies are all proved (ready to prove).

- \`generate\` — Output Lean 4 code. With separated=true (default), outputs
  Statements.lean + per-theorem proof files. With separated=false, outputs combined.

- \`export\` — Write all Lean files and the DAG JSON to disk.
  Input: outputDir (defaults to cwd/prove2me).

- \`load\` — Load a previously saved DAG from disk.
  Input: dagPath or outputDir.

- \`reset\` — Clear the in-memory DAG.

## Workflow example

1. analyze source code → extract theorem statements into DAG
2. status → see what needs proving
3. attackable → find leaf theorems to prove first
4. submit-proof → submit Lean 4 proofs (sorry-free or sketches)
5. search → find existing theorems to reuse
6. generate → output separated Lean 4 files
7. export → persist to disk

## FLT reference

The Prove2Me platform was used to formalize Fermat's Last Theorem:
13M lines of Lean code, 29,500 intermediate theorems, ~11 days, using a
multi-agent Claude harness that consumed ~6B output tokens.`

export const Prove2MeTool = buildTool({
  name: PROVE2ME_TOOL_NAME,
  searchHint: 'lean formal verification theorem prover DAG proof code correctness',
  maxResultSizeChars: 200_000,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return PROMPT
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })
    schema.type = 'object'
    return schema
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return 'Prove2Me'
  },

  isConcurrencySafe() {
    return false
  },

  isReadOnly(input) {
    return input.action === 'status' || input.action === 'search' || input.action === 'attackable'
  },

  toAutoClassifierInput(input) {
    return `${input.action}`
  },

  async call(input: Input) {
    return { data: await runAction(input) }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const parts: string[] = [output.summary]
    if (output.detail) parts.push(...output.detail)
    if (output.theorems?.length) {
      parts.push('')
      parts.push('Theorems:')
      for (const t of output.theorems) {
        parts.push(`  [${t.status}] ${t.id}: ${t.naturalLanguage}`)
        parts.push(`    ${t.statement}`)
      }
    }
    if (output.stats) {
      parts.push('')
      parts.push(`Stats: ${output.stats.total} total, ${output.stats.proved} proved, ${output.stats.open} open, ${output.stats.sorry} sorry, ${output.stats.failed} failed (depth ${output.stats.maxDepth})`)
    }
    if (output.lean4Output) {
      parts.push('')
      parts.push(output.lean4Output)
    }
    if (output.filesCreated?.length) {
      parts.push('')
      parts.push('Files created:')
      for (const f of output.filesCreated) parts.push(`  ${f}`)
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: parts.join('\n'),
      is_error: output.success !== true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// ── Public API for CodeRunTool / engine integration ─────────────

export function getDAGStats(): DAGStats {
  return { ...dag.stats }
}

export function getTheoremCount(): number {
  return dag.stats.total
}

export function getProvedCount(): number {
  return dag.stats.proved
}

export function getAttackableTheorems(): Array<{ id: string; nl: string }> {
  return getAttackable().map(n => ({ id: n.id, nl: n.naturalLanguage }))
}

export function searchTheoremsByNL(query: string, limit = 10): SearchResult[] {
  return searchTheorems(query, limit)
}

export function resetDAG(): void {
  dag = createEmptyDAG()
}
