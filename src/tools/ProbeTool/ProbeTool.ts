import { readdir } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, PROBE_TOOL_NAME } from './prompt.js'
import {
  authorizeTarget,
  fileExists,
  isAuthorized,
  readAuthorizedTargets,
  runCommand,
} from './runtime.js'
import {
  formatFindingsMarkdown,
  nextFindingId,
  readFindings,
  writeFindings,
  type Finding,
} from './findings.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['authorize', 'scan', 'verify', 'fix', 'report'])
      .describe(
        'authorize=add target to allowlist; scan=read-only recon; verify=record a gated finding; fix=attach remediation; report=read the ledger.',
      ),
    target: z
      .string()
      .optional()
      .describe('Authorized target: a local path or repo URL. Required for authorize/scan/verify/fix.'),
    scope: z
      .string()
      .optional()
      .describe('For authorize: who, what, and where the authorization stops.'),
    title: z.string().optional().describe('For verify: finding title.'),
    severity: z
      .enum(['critical', 'high', 'medium', 'low', 'info'])
      .optional()
      .describe('For verify: severity.'),
    confidence: z
      .enum(['high', 'medium', 'low'])
      .optional()
      .describe('For verify: high requires an executed PoC; otherwise cap at medium.'),
    evidence: z.string().optional().describe('For verify: proof (PoC output / source→sink trace / request-response).'),
    poc: z.string().optional().describe('For verify: an executed proof-of-concept (required for high confidence).'),
    counterevidence: z
      .string()
      .optional()
      .describe('For verify: the strongest reason this finding might be a false positive. Required to record as verified.'),
    cwe: z.string().optional().describe('For verify: CWE id if known.'),
    findingId: z.string().optional().describe('For fix: the finding id (prob-NNNN) to attach remediation to.'),
    remediation: z.string().optional().describe('For fix: remediation guidance.'),
    fixBefore: z.string().optional().describe('For fix: white-box original code (fix_before).'),
    fixAfter: z.string().optional().describe('For fix: white-box replacement code (fix_after).'),
    file: z.string().optional().describe('For fix: file path of the code location.'),
    startLine: z.number().int().positive().optional().describe('For fix: start line.'),
    endLine: z.number().int().positive().optional().describe('For fix: end line.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    message: z.string(),
    findingId: z.string().optional(),
    findings: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          severity: z.string(),
          confidence: z.string(),
          status: z.string(),
          target: z.string(),
          cwe: z.string().optional(),
          evidence: z.string().optional(),
          poc: z.string().optional(),
          counterevidence: z.string().optional(),
          remediation: z.string().optional(),
        }),
      )
      .optional(),
    coverage: z
      .array(z.object({ surface: z.string(), outcome: z.string() }))
      .optional(),
    authorized: z.array(z.string()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (input.action === 'report') return 'probetool report'
  if (!input.target) return null
  return `probetool ${input.action} ${input.target}`
}

export const ProbeTool = buildTool({
  name: PROBE_TOOL_NAME,
  searchHint:
    'authorized security probing: scan / verify / fix / report findings for a target you own or are authorized to test',
  maxResultSizeChars: 50_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ProbeTool'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.action === 'report'
      ? 'probetool report'
      : `probetool ${input.action} ${input.target ?? ''}`
  },
  renderToolUseMessage,
  async call(input, context) {
    const signal = context.abortController.signal
    switch (input.action) {
      case 'authorize':
        return runAuthorize(input)
      case 'scan':
        return runScan(input, signal)
      case 'verify':
        return runVerify(input)
      case 'fix':
        return runFix(input)
      case 'report':
        return runReport()
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `probetool ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runAuthorize(input: Input): Promise<{ data: Output }> {
  if (!input.target || !input.scope) {
    return failure('authorize', 'target and scope are required for action "authorize".')
  }
  try {
    await authorizeTarget(input.target, input.scope)
    const targets = await readAuthorizedTargets()
    return {
      data: {
        success: true,
        action: 'authorize',
        message: `Authorized "${input.target}" (scope: ${input.scope}).`,
        authorized: targets.map(t => t.target),
      },
    }
  } catch (error) {
    return failure('authorize', error instanceof Error ? error.message : String(error))
  }
}

async function runScan(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  if (!input.target) {
    return failure('scan', 'target is required for action "scan".')
  }
  const target = input.target
  if (!(await isAuthorized(target))) {
    return failure(
      'scan',
      `"${target}" is not in the authorized-targets allowlist. Run action "authorize" first.`,
    )
  }

  // Only local paths can be statically scanned here; remote URLs are the agent's job via WebFetch.
  const base = resolve(target)
  if (!(await fileExists(base))) {
    return failure('scan', `target not found locally: ${target}`)
  }

  try {
    const entries = await readdir(base).catch(() => [] as string[])
    const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', 'Dockerfile']
    const found = manifests.filter(m => entries.includes(m))

    const coverage = [
      { surface: 'top-level entries', outcome: `${entries.length} entries` },
      { surface: 'manifests', outcome: found.length ? found.join(', ') : 'none detected' },
    ]

    // Best-effort read-only hint: git grep for common dangerous sinks (never executes anything).
    let sinkHints = ''
    const gitDir = join(base, '.git')
    if (await fileExists(gitDir)) {
      const r = await runCommand(
        ['git', '-C', base, 'grep', '-n', '-E', 'eval\\(|exec\\(|system\\(|os\\.system|subprocess|innerHTML|dangerouslySetInnerHTML|exec\\(|SELECT .*\\$|password', '--', '*.js', '*.ts', '*.py', '*.go', '*.java', '*.php'],
        { signal, timeoutMs: 60_000 },
      )
      if (r.exitCode === 0 && r.stdout.trim()) {
        sinkHints = r.stdout.split('\n').slice(0, 20).join('\n')
      }
    }

    return {
      data: {
        success: true,
        action: 'scan',
        message: [
          `Scanned "${target}" (read-only).`,
          `Detected manifests: ${found.length ? found.join(', ') : 'none'}.`,
          sinkHints ? `\nPotential sink locations (grep, verify these):\n${sinkHints}` : '',
          '\nNow audit the code with FileRead/Grep/Glob and record each candidate via action "verify".',
        ]
          .filter(Boolean)
          .join('\n'),
        coverage,
      },
    }
  } catch (error) {
    return failure('scan', error instanceof Error ? error.message : String(error))
  }
}

async function runVerify(input: Input): Promise<{ data: Output }> {
  if (!input.target || !input.title || !input.severity || !input.confidence) {
    return failure('verify', 'target, title, severity and confidence are required for action "verify".')
  }
  const target = input.target
  if (!(await isAuthorized(target))) {
    return failure(
      'verify',
      `"${target}" is not in the authorized-targets allowlist. Run action "authorize" first.`,
    )
  }

  // ── Strix-style verification gate ──────────────────────────────
  const evidence = input.evidence?.trim() ?? ''
  const counterevidence = input.counterevidence?.trim() ?? ''
  const poc = input.poc?.trim() ?? ''

  if (!evidence) {
    return failure('verify', 'evidence is required; a finding without evidence stays candidate and is not recorded.')
  }
  if (!counterevidence) {
    return failure(
      'verify',
      'counterevidence is required — state the strongest reason this might be a false positive, even if it is "none found; evidence is decisive".',
    )
  }

  let confidence = input.confidence
  if (confidence === 'high' && !poc) {
    return failure(
      'verify',
      'confidence "high" requires an executed PoC. Provide poc, or lower confidence to "medium" (strong static evidence, not executed).',
    )
  }

  const status: Finding['status'] = 'verified'

  try {
    const id = await nextFindingId()
    const now = new Date().toISOString()
    const finding: Finding = {
      id,
      title: input.title,
      severity: input.severity,
      confidence,
      status,
      target,
      cwe: input.cwe,
      evidence,
      poc: poc || undefined,
      counterevidence,
      createdAt: now,
      updatedAt: now,
    }
    const findings = await readFindings()
    findings.push(finding)
    await writeFindings(findings)

    return {
      data: {
        success: true,
        action: 'verify',
        message: `Recorded ${id} (${input.severity}/${confidence}, status=${status}): ${input.title}`,
        findingId: id,
        findings: [finding],
      },
    }
  } catch (error) {
    return failure('verify', error instanceof Error ? error.message : String(error))
  }
}

async function runFix(input: Input): Promise<{ data: Output }> {
  if (!input.findingId || !input.remediation) {
    return failure('fix', 'findingId and remediation are required for action "fix".')
  }
  try {
    const findings = await readFindings()
    const finding = findings.find(f => f.id === input.findingId)
    if (!finding) {
      return failure('fix', `finding not found: ${input.findingId}`)
    }
    if (finding.status !== 'verified') {
      return failure('fix', `finding ${input.findingId} is not verified; fix only verified findings.`)
    }

    finding.remediation = input.remediation
    if (input.file && input.startLine && input.endLine) {
      finding.code_locations = [
        {
          file: input.file,
          start_line: input.startLine,
          end_line: input.endLine,
          fix_before: input.fixBefore,
          fix_after: input.fixAfter,
        },
      ]
    }
    finding.updatedAt = new Date().toISOString()
    await writeFindings(findings)

    return {
      data: {
        success: true,
        action: 'fix',
        message: `Attached remediation to ${finding.id}.`,
        findingId: finding.id,
        findings: [finding],
      },
    }
  } catch (error) {
    return failure('fix', error instanceof Error ? error.message : String(error))
  }
}

async function runReport(): Promise<{ data: Output }> {
  try {
    const findings = await readFindings()
    const authorized = (await readAuthorizedTargets()).map(t => t.target)
    return {
      data: {
        success: true,
        action: 'report',
        message: formatFindingsMarkdown(findings),
        findings,
        authorized,
      },
    }
  } catch (error) {
    return failure('report', error instanceof Error ? error.message : String(error))
  }
}
