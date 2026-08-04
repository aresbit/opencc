import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { fileExists } from './runtime.js'

/**
 * Extraction quality is a verdict, not a boolean.
 *
 * The scripts already know when they had to fall back to a lossy path — poor
 * PDF text, no headings, ar5iv HTML instead of the PDF — but the tool used to
 * report a flat `success: true` regardless and hand the agent a garbled blob to
 * "implement" from. A degraded extraction now says so, with reasons, so the
 * agent can fetch the paper another way instead of inventing an implementation.
 */
export type ExtractionQuality = 'ok' | 'degraded' | 'failed'

export interface OfficialCodeLink {
  url: string
  source: string
  context?: string
}

export interface ExtractionReport {
  quality: ExtractionQuality
  /** Why the quality is not `ok`. Empty when it is. */
  issues: string[]
  paperTitle?: string
  paperAuthors?: string[]
  categories?: string[]
  /** Characters of extracted paper body. */
  characters: number
  sections: number
  algorithms: number
  equations: number
  tables: number
  footnotes: number
  /** LaTeX or math markers survived extraction. */
  mathPreserved: boolean
  /** Repos the scripts found in the paper text or on the arXiv page. */
  officialCode: OfficialCodeLink[]
  /** Relative paths that actually exist under the output directory. */
  files: string[]
}

interface PaperMetadata {
  title?: string
  authors?: string[]
  categories?: string[]
  official_code?: OfficialCodeLink[]
}

/** Below this, the "paper" is a stub or a failed parse, not a paper. */
const MIN_USABLE_CHARACTERS = 5_000
/** Fewer than this and section splitting effectively did not happen. */
const MIN_USABLE_SECTIONS = 2

/** Categories where an implementation almost certainly needs equations. */
const MATH_HEAVY_CATEGORIES = /^(cs\.(LG|CV|CL|AI|NE)|stat\.ML|math\.|eess\.)/

async function countEntries(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir)
    return entries.filter(e => !e.startsWith('.')).length
  } catch {
    return 0
  }
}

async function countFootnotes(outputDir: string): Promise<number> {
  try {
    const text = await readFile(join(outputDir, 'footnotes.md'), 'utf-8')
    return (text.match(/^## Footnote \d+/gm) ?? []).length
  } catch {
    return 0
  }
}

async function loadMetadata(outputDir: string): Promise<PaperMetadata | null> {
  try {
    const raw = await readFile(join(outputDir, 'paper_metadata.json'), 'utf-8')
    return JSON.parse(raw) as PaperMetadata
  } catch {
    return null
  }
}

const ARTIFACT_CANDIDATES = [
  'paper_text.md',
  'paper_metadata.json',
  'footnotes.md',
  'sections',
  'algorithms',
  'equations',
  'tables',
]

/**
 * Build the extraction report by inspecting what landed on disk. Reading the
 * filesystem rather than parsing script stdout means the numbers describe the
 * artifacts the agent will actually open.
 */
export async function buildExtractionReport(
  outputDir: string,
): Promise<ExtractionReport> {
  const paperTextPath = join(outputDir, 'paper_text.md')
  const metadata = await loadMetadata(outputDir)

  let characters = 0
  let mathPreserved = false
  if (await fileExists(paperTextPath)) {
    const info = await stat(paperTextPath)
    characters = info.size
    // Only sample the head — enough to tell whether math survived extraction.
    const head = (await readFile(paperTextPath, 'utf-8')).slice(0, 200_000)
    mathPreserved = /\$[^$\n]+\$|\\frac|\\sum|\\int|\\mathbb|\\alpha|\\theta/.test(
      head,
    )
  }

  const [sections, algorithms, equations, tables, footnotes] = await Promise.all([
    countEntries(join(outputDir, 'sections')),
    countEntries(join(outputDir, 'algorithms')),
    countEntries(join(outputDir, 'equations')),
    countEntries(join(outputDir, 'tables')),
    countFootnotes(outputDir),
  ])

  const files: string[] = []
  for (const rel of ARTIFACT_CANDIDATES) {
    if (await fileExists(join(outputDir, rel))) files.push(rel)
  }

  const issues: string[] = []
  let quality: ExtractionQuality = 'ok'

  if (characters === 0) {
    quality = 'failed'
    issues.push('No paper text was extracted.')
  } else {
    if (characters < MIN_USABLE_CHARACTERS) {
      quality = 'degraded'
      issues.push(
        `Only ${characters.toLocaleString()} characters of paper text were extracted — too little for a full paper. The PDF parse likely failed and fell back to a stub.`,
      )
    }
    if (sections < MIN_USABLE_SECTIONS) {
      quality = 'degraded'
      issues.push(
        `Section splitting found ${sections} section(s); the text has no recognizable heading structure, so section-anchored citations will not be reliable.`,
      )
    }
    const categories = metadata?.categories ?? []
    const mathHeavy = categories.some(c => MATH_HEAVY_CATEGORIES.test(c))
    if (equations === 0 && mathHeavy) {
      quality = 'degraded'
      issues.push(
        `No numbered equations were extracted from a ${categories.join('/')} paper. Equation-anchored citations are not available; confirm against the PDF before implementing any formula.`,
      )
    }
    if (!mathPreserved && mathHeavy) {
      quality = 'degraded'
      issues.push(
        'Math notation did not survive extraction. Install pymupdf4llm for math-preserving extraction, or read the equations from the PDF directly.',
      )
    }
  }

  return {
    quality,
    issues,
    paperTitle: metadata?.title,
    paperAuthors: metadata?.authors,
    categories: metadata?.categories,
    characters,
    sections,
    algorithms,
    equations,
    tables,
    footnotes,
    mathPreserved,
    officialCode: metadata?.official_code ?? [],
    files,
  }
}

export interface ManifestInput {
  arxivId: string
  framework: string
  mode: string
  outputDir: string
  pythonManaged: boolean
  missingOptionalDeps: string[]
  report: ExtractionReport
}

/**
 * Persist the run's parameters and verdict next to the artifacts. `framework`
 * and `mode` are documented as "recorded in the output metadata" — before this
 * they were accepted and dropped, so the documentation was simply untrue.
 */
export async function writeManifest(input: ManifestInput): Promise<string> {
  const path = join(input.outputDir, 'paper2code_manifest.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        schemaVersion: 'paper2code_manifest_v1',
        arxivId: input.arxivId,
        framework: input.framework,
        mode: input.mode,
        extractedAt: new Date().toISOString(),
        pythonEnvironment: input.pythonManaged ? 'managed-venv' : 'system',
        missingOptionalDeps: input.missingOptionalDeps,
        extraction: input.report,
      },
      null,
      2,
    ),
  )
  return path
}

/** Human-readable summary handed back to the model. */
export function formatExtractionReport(
  arxivId: string,
  outputDir: string,
  report: ExtractionReport,
): string {
  const lines = [
    `paper2code extracted ${arxivId} → ${outputDir}`,
    report.paperTitle ? `Title: ${report.paperTitle}` : null,
    report.paperAuthors?.length
      ? `Authors: ${report.paperAuthors.slice(0, 6).join(', ')}${report.paperAuthors.length > 6 ? ', …' : ''}`
      : null,
    '',
    `Extraction quality: ${report.quality.toUpperCase()}`,
    `  text: ${report.characters.toLocaleString()} chars · sections: ${report.sections} · algorithms: ${report.algorithms} · equations: ${report.equations} · tables: ${report.tables} · footnotes: ${report.footnotes}`,
    `  math notation preserved: ${report.mathPreserved ? 'yes' : 'no'}`,
  ].filter((l): l is string => l !== null)

  if (report.issues.length > 0) {
    lines.push('', 'Extraction issues — do not paper over these:')
    for (const issue of report.issues) lines.push(`  ! ${issue}`)
  }

  if (report.officialCode.length > 0) {
    lines.push('', 'Official code found (read this before implementing anything):')
    for (const link of report.officialCode.slice(0, 8)) {
      lines.push(`  · ${link.url} (${link.source})`)
    }
  } else {
    lines.push(
      '',
      'No official code repository was found in the paper text or on the arXiv page.',
    )
  }

  lines.push(
    '',
    'Artifacts:',
    ...report.files.map(f => `  ${f}`),
    '',
    'This tool extracts and structures the paper. It does not write the implementation — that is your job, from these artifacts. When you have written code, run paper2code with action "verify" to check it against the machine-checkable claims.',
  )

  return lines.join('\n')
}
