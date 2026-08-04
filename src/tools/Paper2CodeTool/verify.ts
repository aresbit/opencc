import { readdir, readFile } from 'fs/promises'
import { join, relative } from 'path'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  fileExists,
  runCommand,
} from './runtime.js'

/**
 * Verification of a generated implementation.
 *
 * The tool description has always promised that generated code is "verified to
 * actually run", that every line is anchored to a paper section, and that
 * unspecified choices are flagged. Nothing checked any of it — the claims lived
 * in prose and the agent graded its own homework. These checks are the parts of
 * those claims a machine can settle, and they report per-check verdicts rather
 * than one opaque boolean.
 */

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface VerificationCheck {
  id: string
  title: string
  status: CheckStatus
  detail: string
}

export type VerificationVerdict = 'verified' | 'failed' | 'incomplete'

export interface VerificationReport {
  verdict: VerificationVerdict
  reason: string
  checks: VerificationCheck[]
  implDir: string
}

const REQUIRED_FILES = [
  'README.md',
  'REPRODUCTION_NOTES.md',
  'src/model.py',
]

const EXPECTED_FILES = [
  'src/loss.py',
  'src/data.py',
  'src/train.py',
  'src/evaluate.py',
]

/** Markers that anchor a line of code to the paper it came from. */
const CITATION_MARKER =
  /(§\s*[\dA-Z]|\bSec(?:tion)?\.?\s*\d|\bEq(?:uation)?\.?\s*\(?\d|\bAlgorithm\s*\d|\bTable\s*\d|\bFigure\s*\d|\bAppendix\s*[A-Z\d]|\[UNSPECIFIED\])/

/** Definitions that ought to carry an anchor. */
const DEFINITION_LINE = /^\s*(?:class|def)\s+\w+/

const SYNTAX_CHECK_SCRIPT = `
import ast, pathlib, sys
root = pathlib.Path(sys.argv[1])
errors = []
for path in sorted(root.rglob("*.py")):
    if "__pycache__" in path.parts or ".venv" in path.parts:
        continue
    try:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        errors.append(f"{path.relative_to(root)}:{exc.lineno}: {exc.msg}")
    except Exception as exc:
        errors.append(f"{path.relative_to(root)}: {exc}")
if errors:
    print("\\n".join(errors))
    sys.exit(1)
`.trim()

async function collectPythonFiles(dir: string, root = dir): Promise<string[]> {
  const out: string[] = []
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectPythonFiles(full, root)))
    } else if (entry.name.endsWith('.py')) {
      out.push(relative(root, full))
    }
  }
  return out
}

// ── Individual checks ─────────────────────────────────────────────

async function checkStructure(implDir: string): Promise<VerificationCheck> {
  const missingRequired: string[] = []
  const missingExpected: string[] = []

  for (const rel of REQUIRED_FILES) {
    if (!(await fileExists(join(implDir, rel)))) missingRequired.push(rel)
  }
  for (const rel of EXPECTED_FILES) {
    if (!(await fileExists(join(implDir, rel)))) missingExpected.push(rel)
  }

  const hasConfig =
    (await fileExists(join(implDir, 'configs'))) ||
    (await fileExists(join(implDir, 'config.yaml')))
  if (!hasConfig) missingExpected.push('configs/')

  if (missingRequired.length > 0) {
    return {
      id: 'structure',
      title: 'Required files present',
      status: 'fail',
      detail: `Missing: ${missingRequired.join(', ')}. An implementation without these is not deliverable.`,
    }
  }
  return {
    id: 'structure',
    title: 'Required files present',
    status: 'pass',
    detail:
      missingExpected.length > 0
        ? `All required files present. Not found (may be intentional): ${missingExpected.join(', ')}.`
        : 'All required and expected files present.',
  }
}

async function checkSyntax(
  implDir: string,
  python: string,
  signal?: AbortSignal,
): Promise<VerificationCheck> {
  const files = await collectPythonFiles(implDir)
  if (files.length === 0) {
    return {
      id: 'syntax',
      title: 'Python files parse',
      status: 'fail',
      detail: 'No .py files found under the implementation directory.',
    }
  }

  // Parsing with `ast` needs no third-party imports, so it catches pseudo-code
  // and truncated generations even when the ML dependencies are absent — and
  // unlike compileall it leaves no __pycache__ behind in the user's tree.
  const result = await runCommand([python, '-c', SYNTAX_CHECK_SCRIPT, implDir], {
    cwd: implDir,
    signal,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    env: { PYTHONDONTWRITEBYTECODE: '1' },
  })

  if (result.exitCode !== 0) {
    return {
      id: 'syntax',
      title: 'Python files parse',
      status: 'fail',
      detail: `${files.length} file(s) checked; parsing failed:\n${tail(result.stdout || result.stderr, 1500)}`,
    }
  }
  return {
    id: 'syntax',
    title: 'Python files parse',
    status: 'pass',
    detail: `${files.length} Python file(s) compile without syntax errors.`,
  }
}

async function checkImports(
  implDir: string,
  python: string,
  modules: string[],
  signal?: AbortSignal,
): Promise<VerificationCheck> {
  if (modules.length === 0) {
    return {
      id: 'imports',
      title: 'Modules import',
      status: 'skipped',
      detail: 'No modules named to import. Pass importModules to run this check.',
    }
  }

  const failures: string[] = []
  for (const mod of modules) {
    const result = await runCommand([python, '-c', `import ${mod}`], {
      cwd: implDir,
      signal,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      env: { PYTHONPATH: implDir },
    })
    if (result.exitCode !== 0) {
      failures.push(`${mod}: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`)
    }
  }

  if (failures.length > 0) {
    return {
      id: 'imports',
      title: 'Modules import',
      status: 'fail',
      detail: `${failures.length}/${modules.length} import(s) failed:\n${failures.map(f => `  ${f}`).join('\n')}`,
    }
  }
  return {
    id: 'imports',
    title: 'Modules import',
    status: 'pass',
    detail: `${modules.length} module(s) imported cleanly.`,
  }
}

async function checkCitationAnchors(
  implDir: string,
): Promise<VerificationCheck> {
  const files = await collectPythonFiles(join(implDir, 'src'), implDir)
  const targets = files.length > 0 ? files : await collectPythonFiles(implDir)
  if (targets.length === 0) {
    return {
      id: 'citations',
      title: 'Code anchored to the paper',
      status: 'fail',
      detail: 'No Python files to inspect for citation anchors.',
    }
  }

  let definitions = 0
  let anchored = 0
  const unanchored: string[] = []

  for (const rel of targets) {
    const text = await readFile(join(implDir, rel), 'utf-8').catch(() => '')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!DEFINITION_LINE.test(lines[i]!)) continue
      definitions++
      // An anchor may sit on the definition, in the few lines above it, or in
      // the docstring immediately below.
      const window = lines.slice(Math.max(0, i - 4), i + 8).join('\n')
      if (CITATION_MARKER.test(window)) {
        anchored++
      } else if (unanchored.length < 10) {
        unanchored.push(`${rel}:${i + 1} ${lines[i]!.trim()}`)
      }
    }
  }

  if (definitions === 0) {
    return {
      id: 'citations',
      title: 'Code anchored to the paper',
      status: 'fail',
      detail:
        'No class or function definitions found — there is no implementation to anchor.',
    }
  }

  const ratio = anchored / definitions
  const summary = `${anchored}/${definitions} definitions carry a paper anchor (§/Section/Eq./Algorithm/Table/Appendix or [UNSPECIFIED]).`

  if (ratio < 0.8) {
    return {
      id: 'citations',
      title: 'Code anchored to the paper',
      status: 'fail',
      detail: `${summary} Unanchored code is code nobody can trace back to the paper. Unanchored definitions:\n${unanchored.map(u => `  ${u}`).join('\n')}`,
    }
  }
  return {
    id: 'citations',
    title: 'Code anchored to the paper',
    status: 'pass',
    detail: summary,
  }
}

async function checkUnspecifiedAudit(
  implDir: string,
): Promise<VerificationCheck> {
  const notesPath = join(implDir, 'REPRODUCTION_NOTES.md')
  const notes = await readFile(notesPath, 'utf-8').catch(() => null)
  if (notes === null) {
    return {
      id: 'unspecified_audit',
      title: 'UNSPECIFIED choices documented',
      status: 'fail',
      detail: 'REPRODUCTION_NOTES.md is missing, so the ambiguity audit does not exist.',
    }
  }

  const files = await collectPythonFiles(implDir)
  const inCode = new Set<string>()
  for (const rel of files) {
    const text = await readFile(join(implDir, rel), 'utf-8').catch(() => '')
    if (/\[UNSPECIFIED\]/.test(text)) inCode.add(rel)
  }

  const notesMentions = (notes.match(/\[UNSPECIFIED\]/g) ?? []).length

  if (inCode.size > 0 && notesMentions === 0) {
    return {
      id: 'unspecified_audit',
      title: 'UNSPECIFIED choices documented',
      status: 'fail',
      detail: `${inCode.size} file(s) mark choices as [UNSPECIFIED] but REPRODUCTION_NOTES.md never mentions one. Every invented value must be listed in the audit: ${[...inCode].join(', ')}.`,
    }
  }

  if (inCode.size === 0 && notesMentions === 0) {
    return {
      id: 'unspecified_audit',
      title: 'UNSPECIFIED choices documented',
      status: 'fail',
      detail:
        'Neither the code nor REPRODUCTION_NOTES.md flags a single [UNSPECIFIED] choice. No real paper specifies every implementation detail — an empty ambiguity audit means the audit was skipped, not that the paper was complete.',
    }
  }

  return {
    id: 'unspecified_audit',
    title: 'UNSPECIFIED choices documented',
    status: 'pass',
    detail: `${notesMentions} [UNSPECIFIED] entr(ies) in REPRODUCTION_NOTES.md, ${inCode.size} source file(s) carry matching markers.`,
  }
}

async function checkSmoke(
  implDir: string,
  command: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VerificationCheck> {
  if (!command) {
    return {
      id: 'smoke',
      title: 'Smoke run',
      status: 'skipped',
      detail:
        'No smokeCommand given. Pass one (e.g. a forward pass or a single training step) to prove the code actually runs.',
    }
  }

  const result = await runCommand(['sh', '-c', command], {
    cwd: implDir,
    signal,
    timeoutMs,
    env: { PYTHONPATH: implDir },
  })

  if (result.timedOut) {
    return {
      id: 'smoke',
      title: 'Smoke run',
      status: 'fail',
      detail: `\`${command}\` timed out after ${Math.round(timeoutMs / 1000)}s.`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      id: 'smoke',
      title: 'Smoke run',
      status: 'fail',
      detail: `\`${command}\` exited ${result.exitCode}:\n${tail(result.stderr || result.stdout, 2000)}`,
    }
  }
  return {
    id: 'smoke',
    title: 'Smoke run',
    status: 'pass',
    detail: `\`${command}\` exited 0.${result.stdout.trim() ? `\n${tail(result.stdout, 800)}` : ''}`,
  }
}

// ── Orchestration ─────────────────────────────────────────────────

export interface VerifyOptions {
  implDir: string
  python: string
  importModules?: string[]
  smokeCommand?: string
  smokeTimeoutMs?: number
  signal?: AbortSignal
}

export async function verifyImplementation(
  options: VerifyOptions,
): Promise<VerificationReport> {
  const { implDir, python, signal } = options

  const checks: VerificationCheck[] = [
    await checkStructure(implDir),
    await checkSyntax(implDir, python, signal),
    await checkCitationAnchors(implDir),
    await checkUnspecifiedAudit(implDir),
    await checkImports(implDir, python, options.importModules ?? [], signal),
    await checkSmoke(
      implDir,
      options.smokeCommand,
      options.smokeTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      signal,
    ),
  ]

  const failed = checks.filter(c => c.status === 'fail')
  if (failed.length > 0) {
    return {
      verdict: 'failed',
      reason: `${failed.length} check(s) failed: ${failed.map(c => c.id).join(', ')}.`,
      checks,
      implDir,
    }
  }

  // "It parses" is not "it runs". Without at least one execution check the
  // implementation is unproven, and saying so is the honest verdict.
  const ranExecution = checks.some(
    c => (c.id === 'imports' || c.id === 'smoke') && c.status === 'pass',
  )
  if (!ranExecution) {
    return {
      verdict: 'incomplete',
      reason:
        'Static checks passed but nothing executed the code. Re-run with importModules (e.g. ["src.model"]) or a smokeCommand that does a forward pass or one training step.',
      checks,
      implDir,
    }
  }

  return {
    verdict: 'verified',
    reason: `All ${checks.filter(c => c.status !== 'skipped').length} applicable checks passed, including execution.`,
    checks,
    implDir,
  }
}

export function formatVerificationReport(report: VerificationReport): string {
  const marker = (s: CheckStatus) =>
    s === 'pass' ? '✓' : s === 'fail' ? '✗' : '–'
  const lines = [
    `paper2code verification of ${report.implDir}`,
    `Verdict: ${report.verdict.toUpperCase()} — ${report.reason}`,
    '',
  ]
  for (const check of report.checks) {
    lines.push(`${marker(check.status)} ${check.title}`)
    for (const detailLine of check.detail.split('\n')) {
      lines.push(`    ${detailLine}`)
    }
  }
  if (report.verdict !== 'verified') {
    lines.push(
      '',
      'Do not describe this implementation as working or verified. Fix the failures and verify again, or state plainly which checks did not pass.',
    )
  }
  return lines.join('\n')
}

function tail(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `…${trimmed.slice(-maxChars)}`
}

function firstLine(text: string): string {
  const lines = text.trim().split('\n').filter(Boolean)
  // Python tracebacks put the useful message last.
  return lines.at(-1) ?? ''
}
