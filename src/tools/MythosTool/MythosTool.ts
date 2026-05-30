import { access, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { runAgent } from '../AgentTool/runAgent.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { getCwd } from '../../utils/cwd.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  userFacingName,
} from './UI.js'
import {
  ADVERSARIAL_PROBE_SYSTEM_PROMPT,
  CODA_SYSTEM_PROMPT,
  DISTILLATION_SYSTEM_PROMPT,
  HALTING_JUDGE_SYSTEM_PROMPT,
  MYTHOS_TOOL_NAME,
  PRELUDE_SYSTEM_PROMPT,
  RECURRENT_BLOCK_SYSTEM_PROMPT,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['research', 'status', 'continue', 'clear'])
      .optional()
      .default('research')
      .describe('Action to perform. Default: research'),
    topic: z
      .string()
      .optional()
      .describe('Research topic or question. Required for research action.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(3)
      .describe('Maximum recurrent depth for deep dives (1-10). Default: 3'),
    breadth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .default(2)
      .describe('Number of parallel research directions per depth. Default: 2'),
    outputDir: z
      .string()
      .optional()
      .describe('Output directory for research artifacts. Default: ./mythos_output/'),
    extendCap: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .default(3)
      .describe('Max extra depths the halting judge may add beyond depth. Default: 3'),
    skipAdversarial: z
      .boolean()
      .optional()
      .default(false)
      .describe('Skip the adversarial probe phase. Default: false (probe enabled).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

// ============================================================
// Structured latent state schemas
// ============================================================

const claimSchema = z.object({
  id: z.string(),
  statement: z.string(),
  evidence: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low', 'speculative']).default('medium'),
  sources: z.array(z.string()).default([]),
  source_types: z.array(z.string()).default([]),
  confirms: z.array(z.string()).default([]),
  extends: z.array(z.string()).default([]),
  challenged_by: z.array(z.string()).default([]),
  probe_verdict: z.enum(['survives', 'wounded', 'broken', 'unprobed']).default('unprobed'),
  caveats: z.array(z.string()).default([]),
  depthIntroduced: z.number().optional(),
  direction: z.string().optional(),
})

const contradictionSchema = z.object({
  id: z.string(),
  claim_ids_involved: z.array(z.string()).default([]),
  description: z.string(),
  evidence_weight: z
    .enum(['left_stronger', 'right_stronger', 'equal', 'context_dependent'])
    .optional(),
  rationale: z.string().optional(),
  resolution: z
    .enum(['unresolved', 'left_stronger', 'right_stronger', 'context_dependent'])
    .default('unresolved'),
  resolutionRationale: z.string().optional(),
  depthIntroduced: z.number().optional(),
})

const directionSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string().optional(),
  expected_uncertainty: z.enum(['high', 'medium', 'low']).optional(),
  starting_queries: z.array(z.string()).default([]),
  source: z.enum(['prelude', 'adaptive']).default('prelude'),
})

const sourceRecordSchema = z.object({
  url_or_citation: z.string(),
  source_type: z.string(),
  credibility_note: z.string().optional(),
})

const findingSchema = z.object({
  depth: z.number(),
  direction: z.string(),
  narrative: z.string().optional(),
  new_claims: z.array(claimSchema).default([]),
  new_contradictions: z.array(contradictionSchema).default([]),
  new_open_questions: z.array(z.string()).default([]),
  resolved_open_questions: z.array(z.string()).default([]),
  sources_consulted_this_iter: z.array(sourceRecordSchema).default([]),
  timestamp: z.number(),
})

const latentStateSchema = z.object({
  topic: z.string(),
  landscapeMap: z.string().optional(),
  // Structured state
  claims: z.array(claimSchema).default([]),
  contradictions: z.array(contradictionSchema).default([]),
  // Adaptive directions
  directions: z.array(directionSchema).default([]),
  completedDirectionIds: z.array(z.string()).default([]),
  pendingDirectionIds: z.array(z.string()).default([]),
  // Open questions
  openQuestions: z.array(z.string()).default([]),
  resolvedQuestions: z.array(z.string()).default([]),
  // Source tracking
  sourceTypeCounts: z.record(z.string(), z.number()).default({}),
  allSources: z.array(sourceRecordSchema).default([]),
  // Convergence tracking
  convergenceScore: z.number().default(0),
  haltingDecisions: z
    .array(
      z.object({
        depth: z.number(),
        decision: z.enum(['halt', 'continue', 'extend']),
        rationale: z.string(),
        timestamp: z.number(),
      }),
    )
    .default([]),
  // Counters
  currentDepth: z.number(),
  maxDepth: z.number(),
  extendedDepth: z.number().default(0),
  breadth: z.number(),
  // Legacy bullet-list compat (kept for older readers)
  accumulatedFindings: z.array(z.string()).default([]),
  contradictionsLegacy: z.array(z.string()).default([]),
})

const runtimeStateSchema = z.object({
  mode: z.enum(['active', 'inactive']),
  workDir: z.string(),
  topic: z.string().optional(),
  updatedAt: z.string(),
  latentState: latentStateSchema.optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the research succeeded'),
    mode: z.enum(['active', 'inactive']).describe('Mythos mode after this call'),
    action: z
      .enum(['research', 'status', 'continue', 'clear'])
      .describe('Executed action'),
    message: z.string().describe('Status message'),
    reportPath: z.string().optional().describe('Path to generated research report'),
    depthReached: z.number().optional().describe('Maximum depth reached'),
    findingsCount: z.number().optional().describe('Total claims accumulated'),
    contradictionsResolved: z.number().optional(),
    convergenceScore: z.number().optional(),
    probeRobustness: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export type MythosProgress = {
  type: 'mythos_progress'
  phase: 'prelude' | 'recurrent' | 'distillation' | 'halting' | 'adversarial' | 'coda'
  depth?: number
  direction?: string
  message: Message
}

const MYTHOS_STATE = 'mythos_state.json'
const MYTHOS_FINDINGS = 'mythos_findings.jsonl'
const MYTHOS_REPORT = 'mythos_research.md'
const MYTHOS_SOURCES = 'mythos_sources.md'
const MYTHOS_CLAIMS = 'mythos_claims.json'
const MYTHOS_ADVERSARIAL = 'mythos_adversarial.md'
const DEFAULT_DEPTH = 3
const DEFAULT_BREADTH = 2

type LatentState = z.infer<typeof latentStateSchema>
type Claim = z.infer<typeof claimSchema>
type Contradiction = z.infer<typeof contradictionSchema>
type Direction = z.infer<typeof directionSchema>

function nowIso(): string {
  return new Date().toISOString()
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function defaultOutputDir(topic: string): string {
  const sanitized = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 50)
    .replace(/^_+|_+$/g, '')
  return resolve(process.cwd(), 'mythos_output', sanitized || 'research')
}

async function readRuntimeState(workDir: string): Promise<z.infer<typeof runtimeStateSchema> | null> {
  const p = join(workDir, MYTHOS_STATE)
  if (!(await exists(p))) return null
  try {
    const raw = await readFile(p, 'utf-8')
    const parsed = JSON.parse(raw)
    // tolerant parse — allow older state files
    const safe = runtimeStateSchema.safeParse(parsed)
    if (safe.success) return safe.data
    // graceful fallback: reconstruct minimum required
    return parsed as z.infer<typeof runtimeStateSchema>
  } catch {
    return null
  }
}

async function writeRuntimeState(
  workDir: string,
  state: z.infer<typeof runtimeStateSchema>,
): Promise<void> {
  await writeFile(join(workDir, MYTHOS_STATE), JSON.stringify(state, null, 2), 'utf-8')
}

async function appendFindings(workDir: string, record: z.infer<typeof findingSchema>): Promise<void> {
  const p = join(workDir, MYTHOS_FINDINGS)
  let current = ''
  if (await exists(p)) {
    current = await readFile(p, 'utf-8')
  }
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
  await writeFile(p, `${current}${prefix}${JSON.stringify(record)}\n`, 'utf-8')
}

async function initWorkspace(
  workDir: string,
  topic: string,
  depth: number,
  breadth: number,
): Promise<void> {
  await mkdir(workDir, { recursive: true })

  const initialState: z.infer<typeof runtimeStateSchema> = {
    mode: 'active',
    workDir,
    topic,
    updatedAt: nowIso(),
    latentState: {
      topic,
      claims: [],
      contradictions: [],
      directions: [],
      completedDirectionIds: [],
      pendingDirectionIds: [],
      openQuestions: [],
      resolvedQuestions: [],
      sourceTypeCounts: {},
      allSources: [],
      convergenceScore: 0,
      haltingDecisions: [],
      currentDepth: 0,
      maxDepth: depth,
      extendedDepth: 0,
      breadth,
      accumulatedFindings: [],
      contradictionsLegacy: [],
    },
  }
  await writeRuntimeState(workDir, initialState)
}

// ============================================================
// Parsing helpers
// ============================================================

function extractFencedJson(text: string): unknown | null {
  // Match ```json ... ``` first; fall back to any fenced block that looks like JSON
  const jsonFence = /```json\s*\n([\s\S]*?)\n```/i.exec(text)
  if (jsonFence?.[1]) {
    try {
      return JSON.parse(jsonFence[1])
    } catch {
      // fall through
    }
  }
  const anyFence = /```\s*\n(\{[\s\S]*?\}|\[[\s\S]*?\])\s*\n```/.exec(text)
  if (anyFence?.[1]) {
    try {
      return JSON.parse(anyFence[1])
    } catch {
      // fall through
    }
  }
  // Last resort: locate first balanced top-level JSON object
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function extractSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const regex = /##\s+(.+?)\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const title = match[1].trim().toLowerCase().replace(/\s+/g, '_')
    sections[title] = match[2].trim()
  }
  return sections
}

function parseBulletList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- ') || line.startsWith('* '))
    .map(line => line.slice(2).trim())
    .filter(Boolean)
}

function parseNumberedList(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\d+\.\s/.test(line))
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
}

// ============================================================
// State-mutation helpers
// ============================================================

function findClaim(state: LatentState, id: string): Claim | undefined {
  return state.claims.find(c => c.id === id)
}

function incrementSourceTypes(state: LatentState, types: string[]) {
  for (const t of types) {
    if (!t) continue
    state.sourceTypeCounts[t] = (state.sourceTypeCounts[t] ?? 0) + 1
  }
}

function loadBearingScore(state: LatentState, claimId: string): number {
  let count = 0
  for (const c of state.claims) {
    if (c.confirms?.includes(claimId)) count++
    if (c.extends?.includes(claimId)) count++
  }
  for (const x of state.contradictions) {
    if (x.claim_ids_involved.includes(claimId)) count++
  }
  return count
}

function summarizeLatentForPrompt(state: LatentState, opts?: { maxClaims?: number; maxQuestions?: number; maxContradictions?: number }): string {
  const maxClaims = opts?.maxClaims ?? 25
  const maxQuestions = opts?.maxQuestions ?? 12
  const maxContradictions = opts?.maxContradictions ?? 10

  // Sort claims by confidence then by load-bearing
  const ranked = [...state.claims].sort((a, b) => {
    const confOrder = { high: 0, medium: 1, low: 2, speculative: 3 } as Record<string, number>
    const ca = confOrder[a.confidence] ?? 4
    const cb = confOrder[b.confidence] ?? 4
    if (ca !== cb) return ca - cb
    return loadBearingScore(state, b.id) - loadBearingScore(state, a.id)
  })

  const claimsBlock = ranked.slice(0, maxClaims).map(c =>
    `  - [${c.id}, ${c.confidence}] ${c.statement}` +
    (c.sources.length ? ` (sources: ${c.sources.slice(0, 3).join('; ')})` : ''),
  )

  const contradictionsBlock = state.contradictions.slice(0, maxContradictions).map(x =>
    `  - [${x.id}] ${x.description} (resolution=${x.resolution})`,
  )

  const sourceMap = Object.entries(state.sourceTypeCounts)
    .map(([t, n]) => `${t}=${n}`)
    .join(', ')

  return [
    `Topic: ${state.topic}`,
    `Current depth: ${state.currentDepth} / max ${state.maxDepth} (extended +${state.extendedDepth})`,
    `Total claims: ${state.claims.length} | contradictions: ${state.contradictions.length} | open questions: ${state.openQuestions.length}`,
    `Source diversity map: ${sourceMap || '(empty)'}`,
    `Convergence score: ${state.convergenceScore.toFixed(2)}`,
    '',
    'TOP CLAIMS (ranked by confidence + load-bearing):',
    ...(claimsBlock.length ? claimsBlock : ['  (none yet)']),
    '',
    'CONTRADICTIONS:',
    ...(contradictionsBlock.length ? contradictionsBlock : ['  (none)']),
    '',
    'OPEN QUESTIONS:',
    ...(state.openQuestions.slice(0, maxQuestions).map(q => `  - ${q}`) || ['  (none)']),
  ].join('\n')
}

// ============================================================
// Subagent driver
// ============================================================

async function runSubagentPhase(
  promptText: string,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
  phase: MythosProgress['phase'],
  depth?: number,
  direction?: string,
): Promise<string> {
  const { GENERAL_PURPOSE_AGENT } = await import('../AgentTool/built-in/generalPurposeAgent.js')
  const userMessage = createUserMessage(promptText)
  const agentMessages: Message[] = []

  for await (const message of runAgent({
    agentDefinition: GENERAL_PURPOSE_AGENT,
    promptMessages: [userMessage],
    toolUseContext: context,
    canUseTool,
    isAsync: false,
    querySource: 'agent:custom',
    model: undefined,
    availableTools: context.options.tools,
    override: { agentId: `mythos-${phase}-${Date.now()}` },
  })) {
    agentMessages.push(message)

    if (onProgress && (message.type === 'assistant' || message.type === 'user')) {
      onProgress({
        toolUseID: `mythos_${parentMessage?.message.id || 'unknown'}`,
        data: {
          message,
          type: 'mythos_progress',
          phase,
          depth,
          direction,
        } satisfies MythosProgress,
      })
    }
  }

  let resultText = ''
  for (const msg of agentMessages) {
    if (msg.type === 'assistant' && msg.message.content) {
      const content = msg.message.content
      if (typeof content === 'string') {
        resultText += content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            resultText += block.text
          }
        }
      }
    }
  }
  return resultText.trim()
}

// ============================================================
// Prompt builders
// ============================================================

function buildPreludePrompt(topic: string): string {
  return `${PRELUDE_SYSTEM_PROMPT}\n\nResearch topic: ${topic}\n\nPerform broad exploration now.`
}

function buildRecurrentPrompt(
  direction: Direction,
  depth: number,
  state: LatentState,
): string {
  const stateSummary = summarizeLatentForPrompt(state)
  const queryHints = direction.starting_queries.length
    ? `\nSuggested starting queries:\n${direction.starting_queries.map(q => `  - ${q}`).join('\n')}`
    : ''
  return [
    RECURRENT_BLOCK_SYSTEM_PROMPT,
    '',
    '## Latent State (structured)',
    stateSummary,
    '',
    '## Current Task',
    `Direction: ${direction.title}`,
    `Direction ID: ${direction.id}`,
    `Depth level: ${depth}`,
    direction.rationale ? `Rationale: ${direction.rationale}` : '',
    queryHints,
    '',
    'Execute deep dive now. Remember: end with the structured JSON block.',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildDistillationPrompt(state: LatentState, depthJustCompleted: number): string {
  const stateSummary = summarizeLatentForPrompt(state, { maxClaims: 60, maxQuestions: 30, maxContradictions: 25 })
  return [
    DISTILLATION_SYSTEM_PROMPT,
    '',
    `Depth just completed: ${depthJustCompleted}`,
    '',
    '## Full Accumulated Latent State',
    stateSummary,
    '',
    'Run distillation now. Emit the JSON block.',
  ].join('\n')
}

function buildHaltingPrompt(state: LatentState, depthJustCompleted: number, maxDepth: number, extendCap: number): string {
  const unresolved = state.contradictions.filter(x => x.resolution === 'unresolved').length
  const sourceTypes = Object.keys(state.sourceTypeCounts).length
  const highCount = state.claims.filter(c => c.confidence === 'high').length
  const lowOrSpec = state.claims.filter(c => c.confidence === 'low' || c.confidence === 'speculative').length
  return [
    HALTING_JUDGE_SYSTEM_PROMPT,
    '',
    `Depth just completed: ${depthJustCompleted}`,
    `Planned max depth: ${maxDepth}`,
    `Extend cap: +${extendCap}`,
    `Convergence score: ${state.convergenceScore.toFixed(2)}`,
    `Unresolved contradictions: ${unresolved}`,
    `Open questions: ${state.openQuestions.length}`,
    `High-confidence claims: ${highCount}`,
    `Low/speculative claims: ${lowOrSpec}`,
    `Source-type variety (count of distinct types): ${sourceTypes}`,
    `Source-type histogram: ${JSON.stringify(state.sourceTypeCounts)}`,
    '',
    'Decide now. Emit the JSON block.',
  ].join('\n')
}

function buildAdversarialPrompt(state: LatentState): string {
  // Rank claims by load-bearing score for the prompt
  const ranked = [...state.claims]
    .map(c => ({ claim: c, score: loadBearingScore(state, c.id) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map(({ claim, score }) =>
      `- [${claim.id}, ${claim.confidence}, load=${score}] ${claim.statement} (sources: ${claim.sources.slice(0, 2).join('; ')})`,
    )

  return [
    ADVERSARIAL_PROBE_SYSTEM_PROMPT,
    '',
    '## Load-bearing claims (ranked)',
    ...ranked,
    '',
    '## Full latent state context',
    summarizeLatentForPrompt(state, { maxClaims: 30 }),
    '',
    'Probe the top claims now. Emit the JSON block at the end.',
  ].join('\n')
}

function buildCodaPrompt(topic: string, state: LatentState): string {
  const claimsBlock = state.claims.map(c =>
    `- [${c.id}] (${c.confidence}, verdict=${c.probe_verdict}) ${c.statement}` +
    (c.caveats.length ? ` | caveats: ${c.caveats.join('; ')}` : '') +
    (c.sources.length ? ` | sources: ${c.sources.join('; ')}` : ''),
  )
  const contradictionsBlock = state.contradictions.map(x =>
    `- [${x.id}] ${x.description} | resolution=${x.resolution}${x.resolutionRationale ? ` (${x.resolutionRationale})` : ''}`,
  )
  return [
    CODA_SYSTEM_PROMPT,
    '',
    `Research topic: ${topic}`,
    '',
    '## Complete Structured Latent State',
    `Depths explored: ${state.currentDepth} / max ${state.maxDepth} (+${state.extendedDepth} extended)`,
    `Convergence score: ${state.convergenceScore.toFixed(2)}`,
    `Source-type histogram: ${JSON.stringify(state.sourceTypeCounts)}`,
    '',
    '### Claims',
    ...(claimsBlock.length ? claimsBlock : ['(none)']),
    '',
    '### Contradictions',
    ...(contradictionsBlock.length ? contradictionsBlock : ['(none)']),
    '',
    '### Open Questions',
    ...state.openQuestions.map(q => `- ${q}`),
    '',
    '### Resolved Questions',
    ...state.resolvedQuestions.map(q => `- ${q}`),
    '',
    'Produce the final synthesis now. Follow the report structure exactly.',
  ].join('\n')
}

// ============================================================
// Phase runners
// ============================================================

async function runPrelude(
  workDir: string,
  topic: string,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
): Promise<{ landscapeMap: string; directions: Direction[] }> {
  const preludeText = await runSubagentPhase(
    buildPreludePrompt(topic),
    context,
    canUseTool,
    parentMessage,
    onProgress,
    'prelude',
  )

  await writeFile(join(workDir, 'mythos_prelude.md'), preludeText, 'utf-8')

  // Parse structured directions from JSON block
  let directions: Direction[] = []
  const json = extractFencedJson(preludeText) as { directions?: unknown[] } | null
  if (json && Array.isArray(json.directions)) {
    for (const raw of json.directions) {
      const parsed = directionSchema.safeParse({ ...raw, source: 'prelude' })
      if (parsed.success) directions.push(parsed.data)
    }
  }

  // Fallback to legacy text parsing if JSON missing
  if (directions.length === 0) {
    const sections = extractSections(preludeText)
    const directionsText =
      sections['recommended_deep_dive_directions_ranked'] ||
      sections['deep_dive_directions'] ||
      sections['recommended_directions'] ||
      ''
    directions = parseNumberedList(directionsText).slice(0, 5).map((title, i) => ({
      id: `d${i + 1}`,
      title,
      starting_queries: [],
      source: 'prelude' as const,
    }))
  }

  // Final fallback
  if (directions.length === 0) {
    directions = [{ id: 'd1', title: topic, starting_queries: [], source: 'prelude' }]
  }

  return { landscapeMap: preludeText, directions }
}

async function runRecurrentDepth(
  workDir: string,
  direction: Direction,
  depth: number,
  state: LatentState,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
): Promise<{ added: number; sources: number }> {
  const recurrentText = await runSubagentPhase(
    buildRecurrentPrompt(direction, depth, state),
    context,
    canUseTool,
    parentMessage,
    onProgress,
    'recurrent',
    depth,
    direction.title,
  )

  // Capture narrative for the finding record
  const sections = extractSections(recurrentText)
  const narrative = sections['research_narrative'] || ''

  // Parse structured JSON update
  const json = extractFencedJson(recurrentText) as
    | {
        new_claims?: unknown[]
        new_contradictions?: unknown[]
        new_open_questions?: string[]
        resolved_open_questions?: string[]
        sources_consulted_this_iter?: unknown[]
      }
    | null

  const newClaims: Claim[] = []
  const newContradictions: Contradiction[] = []
  const newQuestions: string[] = []
  const resolvedQuestions: string[] = []
  const sourcesIter: z.infer<typeof sourceRecordSchema>[] = []

  if (json) {
    for (const raw of json.new_claims ?? []) {
      const parsed = claimSchema.safeParse({
        ...(raw as object),
        depthIntroduced: depth,
        direction: direction.id,
      })
      if (parsed.success) newClaims.push(parsed.data)
    }
    for (const raw of json.new_contradictions ?? []) {
      const parsed = contradictionSchema.safeParse({
        ...(raw as object),
        depthIntroduced: depth,
      })
      if (parsed.success) newContradictions.push(parsed.data)
    }
    if (Array.isArray(json.new_open_questions)) {
      for (const q of json.new_open_questions) if (typeof q === 'string' && q.trim()) newQuestions.push(q.trim())
    }
    if (Array.isArray(json.resolved_open_questions)) {
      for (const q of json.resolved_open_questions) if (typeof q === 'string' && q.trim()) resolvedQuestions.push(q.trim())
    }
    for (const raw of json.sources_consulted_this_iter ?? []) {
      const parsed = sourceRecordSchema.safeParse(raw)
      if (parsed.success) sourcesIter.push(parsed.data)
    }
  }

  // Legacy bullet-list fallback if no JSON parsed
  if (newClaims.length === 0 && newContradictions.length === 0 && newQuestions.length === 0) {
    const fallbackFindings = parseBulletList(sections['new_findings'] || '')
    const fallbackQuestions = parseBulletList(sections['new_open_questions'] || sections['open_questions'] || '')
    const fallbackSources = parseBulletList(sections['sources'] || '')
    let i = 0
    for (const f of fallbackFindings) {
      newClaims.push({
        id: `c${depth}_${direction.id}_${++i}_fb`,
        statement: f,
        evidence: [],
        confidence: 'low',
        sources: fallbackSources,
        source_types: [],
        confirms: [],
        extends: [],
        challenged_by: [],
        probe_verdict: 'unprobed',
        caveats: ['fallback-parsed: no structured JSON in subagent output'],
        depthIntroduced: depth,
        direction: direction.id,
      })
    }
    for (const q of fallbackQuestions) newQuestions.push(q)
  }

  // Merge into latent state
  const claimIdsBefore = new Set(state.claims.map(c => c.id))
  for (const c of newClaims) {
    if (!claimIdsBefore.has(c.id)) state.claims.push(c)
  }
  for (const x of newContradictions) {
    if (!state.contradictions.find(e => e.id === x.id)) state.contradictions.push(x)
  }
  for (const q of newQuestions) {
    if (!state.openQuestions.includes(q)) state.openQuestions.push(q)
  }
  for (const q of resolvedQuestions) {
    const idx = state.openQuestions.indexOf(q)
    if (idx !== -1) state.openQuestions.splice(idx, 1)
    if (!state.resolvedQuestions.includes(q)) state.resolvedQuestions.push(q)
  }
  for (const s of sourcesIter) {
    state.allSources.push(s)
    incrementSourceTypes(state, [s.source_type])
  }
  // Also count source_types embedded inside claims
  for (const c of newClaims) {
    if (c.source_types?.length) incrementSourceTypes(state, c.source_types)
  }

  // Legacy compat: keep bullet-list summaries for older readers
  for (const c of newClaims) state.accumulatedFindings.push(`[${c.id}] ${c.statement}`)
  for (const x of newContradictions) state.contradictionsLegacy.push(`[${x.id}] ${x.description}`)

  await appendFindings(workDir, {
    depth,
    direction: direction.title,
    narrative,
    new_claims: newClaims,
    new_contradictions: newContradictions,
    new_open_questions: newQuestions,
    resolved_open_questions: resolvedQuestions,
    sources_consulted_this_iter: sourcesIter,
    timestamp: Date.now(),
  })

  return { added: newClaims.length, sources: sourcesIter.length }
}

async function runDistillation(
  workDir: string,
  state: LatentState,
  depthJustCompleted: number,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
): Promise<{ convergence: number; newDirections: Direction[] }> {
  const distillText = await runSubagentPhase(
    buildDistillationPrompt(state, depthJustCompleted),
    context,
    canUseTool,
    parentMessage,
    onProgress,
    'distillation',
    depthJustCompleted,
  )

  await writeFile(join(workDir, `mythos_distillation_d${depthJustCompleted}.md`), distillText, 'utf-8')

  const json = extractFencedJson(distillText) as
    | {
        deduplicated?: Array<{ kept_claim_id?: string; merged_claim_ids?: string[] }>
        resolved_contradictions?: Array<{
          contradiction_id?: string
          resolution?: string
          rationale?: string
        }>
        confidence_updates?: Array<{ claim_id?: string; old?: string; new?: string; rationale?: string }>
        adaptive_directions_next_depth?: unknown[]
        convergence_score?: number
        convergence_rationale?: string
      }
    | null

  let newConvergence = state.convergenceScore
  const newDirections: Direction[] = []

  if (json) {
    // Apply deduplication
    for (const dedup of json.deduplicated ?? []) {
      const keptId = dedup.kept_claim_id
      const mergedIds = dedup.merged_claim_ids ?? []
      if (!keptId) continue
      const kept = findClaim(state, keptId)
      if (!kept) continue
      for (const mid of mergedIds) {
        const merged = findClaim(state, mid)
        if (!merged || merged.id === keptId) continue
        // Merge sources/evidence/types into kept
        for (const s of merged.sources) if (!kept.sources.includes(s)) kept.sources.push(s)
        for (const e of merged.evidence) if (!kept.evidence.includes(e)) kept.evidence.push(e)
        for (const t of merged.source_types) if (!kept.source_types.includes(t)) kept.source_types.push(t)
        // Remove merged claim
        state.claims = state.claims.filter(c => c.id !== mid)
        // Rewrite references in other claims
        for (const c of state.claims) {
          c.confirms = c.confirms.map(r => (r === mid ? keptId : r))
          c.extends = c.extends.map(r => (r === mid ? keptId : r))
          c.challenged_by = c.challenged_by.map(r => (r === mid ? keptId : r))
        }
        // Rewrite references in contradictions
        for (const x of state.contradictions) {
          x.claim_ids_involved = x.claim_ids_involved.map(r => (r === mid ? keptId : r))
        }
      }
    }

    // Apply contradiction resolutions
    for (const res of json.resolved_contradictions ?? []) {
      const x = state.contradictions.find(c => c.id === res.contradiction_id)
      if (!x) continue
      const resolution = res.resolution as Contradiction['resolution']
      if (resolution && ['left_stronger', 'right_stronger', 'context_dependent'].includes(resolution)) {
        x.resolution = resolution
        x.resolutionRationale = res.rationale
      }
    }

    // Apply confidence updates
    for (const cu of json.confidence_updates ?? []) {
      const claim = findClaim(state, cu.claim_id ?? '')
      if (!claim) continue
      const newConf = cu.new as Claim['confidence']
      if (newConf && ['high', 'medium', 'low', 'speculative'].includes(newConf)) {
        claim.confidence = newConf
        if (cu.rationale) claim.caveats.push(`distillation: ${cu.rationale}`)
      }
    }

    // Extract adaptive directions
    for (const raw of json.adaptive_directions_next_depth ?? []) {
      const parsed = directionSchema.safeParse({ ...(raw as object), source: 'adaptive' })
      if (parsed.success) newDirections.push(parsed.data)
    }

    if (typeof json.convergence_score === 'number') {
      newConvergence = Math.max(0, Math.min(1, json.convergence_score))
    }
  }

  state.convergenceScore = newConvergence
  return { convergence: newConvergence, newDirections }
}

async function runHaltingJudge(
  state: LatentState,
  depthJustCompleted: number,
  maxDepth: number,
  extendCap: number,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
): Promise<{ decision: 'halt' | 'continue' | 'extend'; rationale: string; focus?: string }> {
  const text = await runSubagentPhase(
    buildHaltingPrompt(state, depthJustCompleted, maxDepth, extendCap),
    context,
    canUseTool,
    parentMessage,
    onProgress,
    'halting',
    depthJustCompleted,
  )

  const json = extractFencedJson(text) as
    | { decision?: string; rationale?: string; next_depth_focus?: string }
    | null

  // Defensive defaults using the rule book
  const unresolved = state.contradictions.filter(x => x.resolution === 'unresolved').length
  const sourceTypes = Object.keys(state.sourceTypeCounts).length
  let decision: 'halt' | 'continue' | 'extend' = 'continue'
  if (json?.decision === 'halt' || json?.decision === 'extend' || json?.decision === 'continue') {
    decision = json.decision
  } else {
    if (state.convergenceScore >= 0.9 && unresolved <= 1 && sourceTypes >= 3) decision = 'halt'
    else if (state.convergenceScore < 0.5 || unresolved >= 4 || sourceTypes <= 1) decision = 'extend'
  }
  const rationale = json?.rationale ?? 'rule-based fallback'
  state.haltingDecisions.push({
    depth: depthJustCompleted,
    decision,
    rationale,
    timestamp: Date.now(),
  })
  return { decision, rationale, focus: json?.next_depth_focus }
}

async function runAdversarialProbe(
  workDir: string,
  state: LatentState,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
): Promise<{ survived: number; wounded: number; broken: number; robustness: string }> {
  const text = await runSubagentPhase(
    buildAdversarialPrompt(state),
    context,
    canUseTool,
    parentMessage,
    onProgress,
    'adversarial',
  )

  await writeFile(join(workDir, MYTHOS_ADVERSARIAL), text, 'utf-8')

  const json = extractFencedJson(text) as
    | {
        probed_claims?: Array<{
          claim_id?: string
          verdict?: string
          revised_confidence?: string
          caveats_to_add?: string[]
          counter_evidence_found?: Array<{ source?: string; summary?: string; weight?: string }>
        }>
        summary?: {
          claims_survived?: number
          claims_wounded?: number
          claims_broken?: number
          overall_robustness?: string
        }
      }
    | null

  let survived = 0
  let wounded = 0
  let broken = 0

  if (json?.probed_claims?.length) {
    for (const pc of json.probed_claims) {
      const claim = findClaim(state, pc.claim_id ?? '')
      if (!claim) continue
      const verdict = pc.verdict as Claim['probe_verdict']
      if (verdict === 'survives' || verdict === 'wounded' || verdict === 'broken') {
        claim.probe_verdict = verdict
        if (verdict === 'survives') survived++
        else if (verdict === 'wounded') wounded++
        else broken++
      }
      const revised = pc.revised_confidence as Claim['confidence']
      if (revised && ['high', 'medium', 'low', 'speculative'].includes(revised)) {
        claim.confidence = revised
      }
      if (Array.isArray(pc.caveats_to_add)) {
        for (const cv of pc.caveats_to_add) if (cv && !claim.caveats.includes(cv)) claim.caveats.push(cv)
      }
      if (Array.isArray(pc.counter_evidence_found)) {
        for (const ce of pc.counter_evidence_found) {
          if (ce.source) claim.challenged_by.push(ce.source)
        }
      }
    }
  }

  const robustness =
    json?.summary?.overall_robustness ??
    (broken > 0 ? 'low' : wounded > survived ? 'medium' : 'high')

  return { survived, wounded, broken, robustness }
}

async function runCoda(
  workDir: string,
  topic: string,
  state: LatentState,
  context: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[1] : never,
  canUseTool: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[2] : never,
  parentMessage: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[3] : never,
  onProgress: Parameters<typeof buildTool>[0] extends { call: (...args: infer P) => any } ? P[4] : never,
): Promise<string> {
  const codaText = await runSubagentPhase(
    buildCodaPrompt(topic, state),
    context,
    canUseTool,
    parentMessage,
    onProgress,
    'coda',
  )

  const reportPath = join(workDir, MYTHOS_REPORT)
  await writeFile(reportPath, codaText, 'utf-8')

  // sources file
  const sourcesContent = [
    '# Mythos Research Sources',
    `Topic: ${topic}`,
    `Generated: ${nowIso()}`,
    '',
    '## Source-type histogram',
    ...Object.entries(state.sourceTypeCounts).map(([t, n]) => `- ${t}: ${n}`),
    '',
    '## All Sources Consulted',
    ...state.allSources.map(
      s => `- [${s.source_type}] ${s.url_or_citation}${s.credibility_note ? ` — ${s.credibility_note}` : ''}`,
    ),
    '',
    '## Directions Explored',
    ...state.directions
      .filter(d => state.completedDirectionIds.includes(d.id))
      .map(d => `- [${d.source}, ${d.id}] ${d.title}`),
  ].join('\n')
  await writeFile(join(workDir, MYTHOS_SOURCES), sourcesContent, 'utf-8')

  // claim graph
  await writeFile(
    join(workDir, MYTHOS_CLAIMS),
    JSON.stringify(
      {
        topic,
        generatedAt: nowIso(),
        claims: state.claims,
        contradictions: state.contradictions,
        openQuestions: state.openQuestions,
        resolvedQuestions: state.resolvedQuestions,
        sourceTypeCounts: state.sourceTypeCounts,
        convergenceScore: state.convergenceScore,
      },
      null,
      2,
    ),
    'utf-8',
  )

  return reportPath
}

// ============================================================
// Main tool
// ============================================================

export const MythosTool = buildTool({
  name: MYTHOS_TOOL_NAME,
  searchHint: 'deep recursive research with structured latent state, distillation, and adversarial probe',
  maxResultSizeChars: 100_000,
  userFacingName,
  async description() {
    return 'Perform deep multi-phase research with recurrent-depth reasoning. Prelude → Recurrent → Distillation → Halting Judge → (loop or extend) → Adversarial Probe → Coda. Produces structured claim graph with confidence and probe verdicts.'
  },
  async prompt() {
    return 'Mythos tool: actions=research|status|continue|clear. Six-phase deep research with structured latent state. Each depth produces structured claims (with evidence + confidence + sources), then distillation compresses + generates adaptive directions, halting judge controls depth, and adversarial probe red-teams load-bearing claims before final synthesis. Produces mythos_research.md, mythos_findings.jsonl (structured), mythos_claims.json, mythos_adversarial.md, mythos_sources.md.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const safeOutput = output && typeof output === 'object' ? (output as Partial<Output>) : undefined
    const content =
      typeof safeOutput?.message === 'string'
        ? safeOutput.message
        : 'Mythos research failed before producing a structured result.'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
      is_error: safeOutput?.success !== true,
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(input, context, canUseTool, parentMessage, onProgress) {
    const action = input.action ?? 'research'
    const cwd = getCwd()
    const topic = input.topic?.trim()
    const extendCap = input.extendCap ?? 3
    const skipAdversarial = input.skipAdversarial ?? false
    const workDir = input.outputDir
      ? isAbsolute(input.outputDir)
        ? input.outputDir
        : resolve(cwd, input.outputDir)
      : topic
        ? defaultOutputDir(topic)
        : resolve(cwd, 'mythos_output')

    if (action === 'status') {
      const runtime = await readRuntimeState(workDir)
      const ls = runtime?.latentState
      const message = [
        `Mode: ${runtime?.mode ?? 'inactive'}`,
        `Work dir: ${workDir}`,
        ls ? `Topic: ${ls.topic}` : '',
        ls ? `Depth: ${ls.currentDepth} / ${ls.maxDepth} (+${ls.extendedDepth ?? 0} extended)` : '',
        ls ? `Convergence: ${(ls.convergenceScore ?? 0).toFixed(2)}` : '',
        ls ? `Claims: ${ls.claims?.length ?? 0}` : '',
        ls ? `Contradictions: ${ls.contradictions?.length ?? 0} (unresolved: ${(ls.contradictions ?? []).filter(x => x.resolution === 'unresolved').length})` : '',
        ls ? `Open questions: ${ls.openQuestions?.length ?? 0}` : '',
        ls ? `Source-type variety: ${Object.keys(ls.sourceTypeCounts ?? {}).length}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      return {
        data: {
          success: true,
          mode: runtime?.mode ?? 'inactive',
          action,
          message,
          reportPath: ls && ls.currentDepth >= ls.maxDepth ? join(workDir, MYTHOS_REPORT) : undefined,
          depthReached: ls?.currentDepth,
          findingsCount: ls?.claims?.length,
          convergenceScore: ls?.convergenceScore,
        },
      }
    }

    if (action === 'clear') {
      const files = [
        MYTHOS_STATE,
        MYTHOS_FINDINGS,
        MYTHOS_REPORT,
        MYTHOS_SOURCES,
        MYTHOS_CLAIMS,
        MYTHOS_ADVERSARIAL,
        'mythos_prelude.md',
      ]
      for (const f of files) {
        const p = join(workDir, f)
        if (await exists(p)) {
          await rm(p, { force: true })
        }
      }
      // Also remove distillation files
      try {
        const { readdir } = await import('fs/promises')
        const entries = await readdir(workDir)
        for (const e of entries) {
          if (e.startsWith('mythos_distillation_d') && e.endsWith('.md')) {
            await rm(join(workDir, e), { force: true })
          }
        }
      } catch {
        // workDir may not exist; ignore
      }
      return {
        data: {
          success: true,
          mode: 'inactive',
          action,
          message: `Cleared Mythos research artifacts in ${workDir}`,
        },
      }
    }

    // research or continue
    if (action === 'research' && !topic) {
      return {
        data: {
          success: false,
          mode: 'inactive',
          action,
          message: 'action=research requires a topic.',
        },
      }
    }

    let runtime = await readRuntimeState(workDir)
    const isContinue = action === 'continue' && !!runtime?.latentState

    if (action === 'research' || !isContinue) {
      const depth = input.depth ?? DEFAULT_DEPTH
      const breadth = input.breadth ?? DEFAULT_BREADTH
      await initWorkspace(workDir, topic!, depth, breadth)
      runtime = await readRuntimeState(workDir)
    }

    if (!runtime?.latentState) {
      return {
        data: {
          success: false,
          mode: 'inactive',
          action,
          message: 'Failed to initialize Mythos workspace.',
        },
      }
    }

    const state = runtime.latentState
    const effectiveTopic = state.topic
    const baseMaxDepth = state.maxDepth
    const breadth = state.breadth

    try {
      // ============================================================
      // PHASE 1: PRELUDE — only if starting fresh
      // ============================================================
      if (!isContinue || state.directions.length === 0) {
        const preludeResult = await runPrelude(
          workDir,
          effectiveTopic,
          context,
          canUseTool,
          parentMessage,
          onProgress,
        )
        state.landscapeMap = preludeResult.landscapeMap
        state.directions = preludeResult.directions
        state.pendingDirectionIds = preludeResult.directions.map(d => d.id)
      }

      // ============================================================
      // PHASE 2-5: RECURRENT LOOP — recurrent → distill → halt → maybe extend
      // ============================================================
      const startDepth = isContinue ? state.currentDepth + 1 : 1
      let d = startDepth
      let effectiveMaxDepth = baseMaxDepth

      while (d <= effectiveMaxDepth) {
        state.currentDepth = d - 1

        // Select directions for this depth (breadth-controlled)
        const available = state.directions.filter(dir => !state.completedDirectionIds.includes(dir.id))
        let selected = available.slice(0, breadth)

        // If all directions explored AND we are at a depth that demanded extension, recycle highest-priority
        if (selected.length === 0) {
          selected = state.directions.slice(0, breadth)
        }

        for (const dir of selected) {
          await runRecurrentDepth(workDir, dir, d, state, context, canUseTool, parentMessage, onProgress)
          if (!state.completedDirectionIds.includes(dir.id)) state.completedDirectionIds.push(dir.id)
          const pendIdx = state.pendingDirectionIds.indexOf(dir.id)
          if (pendIdx !== -1) state.pendingDirectionIds.splice(pendIdx, 1)
        }

        state.currentDepth = d

        // Distillation
        const distillResult = await runDistillation(
          workDir,
          state,
          d,
          context,
          canUseTool,
          parentMessage,
          onProgress,
        )

        // Inject adaptive directions for next depth
        for (const nd of distillResult.newDirections) {
          if (!state.directions.find(x => x.id === nd.id)) {
            state.directions.push(nd)
            state.pendingDirectionIds.push(nd.id)
          }
        }

        // Persist state after each depth
        await writeRuntimeState(workDir, {
          ...runtime,
          mode: 'active',
          updatedAt: nowIso(),
          latentState: state,
        })

        // Halting judge (skip if we are already at the hard cap)
        const reachedHardCap = state.extendedDepth >= extendCap
        if (d >= effectiveMaxDepth) {
          const halt = await runHaltingJudge(
            state,
            d,
            baseMaxDepth,
            extendCap,
            context,
            canUseTool,
            parentMessage,
            onProgress,
          )

          if (halt.decision === 'extend' && !reachedHardCap) {
            effectiveMaxDepth += 1
            state.extendedDepth += 1
          } else {
            // halt or continue-but-no-more-depths-planned -> break
            break
          }
        }

        d += 1
      }

      // ============================================================
      // PHASE 6: ADVERSARIAL PROBE
      // ============================================================
      let probeStats = { survived: 0, wounded: 0, broken: 0, robustness: 'n/a' }
      if (!skipAdversarial && state.claims.length > 0) {
        probeStats = await runAdversarialProbe(
          workDir,
          state,
          context,
          canUseTool,
          parentMessage,
          onProgress,
        )

        // Persist after probe
        await writeRuntimeState(workDir, {
          ...runtime,
          mode: 'active',
          updatedAt: nowIso(),
          latentState: state,
        })
      }

      // ============================================================
      // PHASE 7: CODA
      // ============================================================
      const reportPath = await runCoda(
        workDir,
        effectiveTopic,
        state,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )

      await writeRuntimeState(workDir, {
        ...runtime,
        mode: 'inactive',
        updatedAt: nowIso(),
        latentState: state,
      })

      const unresolved = state.contradictions.filter(x => x.resolution === 'unresolved').length
      const resolved = state.contradictions.length - unresolved

      return {
        data: {
          success: true,
          mode: 'inactive',
          action,
          message:
            `Mythos deep research completed for "${effectiveTopic}".\n` +
            `Depth: ${state.currentDepth} / ${baseMaxDepth} (+${state.extendedDepth} extended)\n` +
            `Claims: ${state.claims.length} | Contradictions: ${state.contradictions.length} (${resolved} resolved)\n` +
            `Open questions: ${state.openQuestions.length} | Convergence: ${state.convergenceScore.toFixed(2)}\n` +
            `Source-type variety: ${Object.keys(state.sourceTypeCounts).length} (${JSON.stringify(state.sourceTypeCounts)})\n` +
            `Adversarial probe: survived=${probeStats.survived}, wounded=${probeStats.wounded}, broken=${probeStats.broken} (robustness=${probeStats.robustness})\n` +
            `Report: ${reportPath}`,
          reportPath,
          depthReached: state.currentDepth,
          findingsCount: state.claims.length,
          contradictionsResolved: resolved,
          convergenceScore: state.convergenceScore,
          probeRobustness: probeStats.robustness,
        },
      }
    } catch (error) {
      await writeRuntimeState(workDir, {
        ...runtime,
        mode: 'inactive',
        updatedAt: nowIso(),
        latentState: state,
      })
      return {
        data: {
          success: false,
          mode: 'inactive',
          action,
          message: `Mythos research failed: ${error instanceof Error ? error.message : String(error)}\nWork dir: ${workDir}`,
        },
      }
    }
  },
  toAutoClassifierInput(input) {
    return input.topic ? `mythos research ${input.topic}` : 'mythos research'
  },
} satisfies ToolDef<InputSchema, Output>)
