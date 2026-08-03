/**
 * Feeding a local code tree into the wiki distiller.
 *
 * `distill` reads sources listed in `wiki/index.md`, which are web documents.
 * A code repository is the other half of the same question — RedoTool answers
 * "how did this project become what it is" from commit history; this answers
 * "what is it now" from the tree as it stands.
 *
 * Two things have to be right, and both are why this is a separate module with
 * its own tests rather than a glob inlined at the call site:
 *
 *   - **Selection must be honest about being a sample.** A repository has more
 *     files than fit in any context window. Silently taking the first N in
 *     readdir order and presenting the result as "the domain model" is the
 *     failure this codebase keeps finding. The caller is told how many files
 *     were skipped.
 *   - **Excerpting must keep the parts that carry domain vocabulary.** Raw
 *     `head -n` on a source file yields the licence header and the import
 *     block. Declarations and doc comments are where the nouns of the domain
 *     live, so they are preferred over function bodies.
 */

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
  '.sql', '.proto', '.graphql',
])

/** Directories that contain no domain knowledge of this project. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv',
  '.cache', 'tmp', 'temp', '.turbo', 'bower_components',
])

/** Files that are generated, vendored, or otherwise not authored here. */
const SKIP_FILE_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.d\.ts$/i, // ambient declarations restate types rather than define behaviour
  /[.-]lock\.(json|yaml|yml)$/i,
  /^package-lock\.json$/i,
  /\.(generated|gen)\.[a-z]+$/i,
  /_pb2?\.py$/i,
  /\.pb\.go$/i,
]

/**
 * Should this path contribute to a distillation?
 *
 * Takes a repo-relative path so the decision is deterministic and testable
 * without a filesystem.
 */
export function shouldIncludeSourceFile(relPath: string): boolean {
  const parts = relPath.split('/')
  const filename = parts[parts.length - 1] ?? ''

  if (parts.slice(0, -1).some(seg => SKIP_DIRS.has(seg) || seg.startsWith('.'))) return false
  if (filename.startsWith('.')) return false
  if (SKIP_FILE_PATTERNS.some(p => p.test(filename))) return false

  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return false
  return SOURCE_EXTENSIONS.has(filename.slice(dot).toLowerCase())
}

const MODIFIERS = String.raw`(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:public\s+|private\s+|protected\s+)?`

/**
 * Type- and function-shaped declarations. Allowed to be indented, because
 * class members and nested types still name domain things.
 */
const TYPE_DECLARATION = new RegExp(
  String.raw`^\s{0,4}${MODIFIERS}(?:class|interface|type|enum|struct|trait|impl|func|function|def|fn|record|protocol|extension|CREATE\s+TABLE|message|service)\b`,
  'i',
)

/**
 * Binding declarations must be top-level or exported.
 *
 * `const`/`let`/`var` are the one case where indentation is the whole signal:
 * a module-level `const SETTLEMENT_LAG = 2` is domain vocabulary, while the
 * `const noise = 1` inside a function body is an implementation detail. An
 * earlier version allowed any indentation and pulled locals out of function
 * bodies as though they were part of the module's interface.
 */
const BINDING_DECLARATION = new RegExp(
  String.raw`^(?:${MODIFIERS}(?:const|let|var)\b|export\s+(?:const|let|var)\b)`,
)

function isDeclaration(line: string): boolean {
  return TYPE_DECLARATION.test(line) || BINDING_DECLARATION.test(line)
}

const DOC_COMMENT_START = /^\s*(?:\/\*\*|"""|'''|#\s|\/\/\/|--\s)/
const IMPORT_LINE = /^\s*(?:import|from|require|use|#include|using|package)\b/

/**
 * Excerpt a source file, preferring the parts that name domain concepts.
 *
 * Keeps the leading doc comment, every declaration line, and the comment lines
 * immediately above declarations; drops import blocks and function bodies. A
 * plain head-of-file excerpt spends its whole budget on licence text and
 * imports, which name the project's dependencies rather than its domain.
 */
export function excerptCode(content: string, maxChars = 2000): string {
  const lines = content.split('\n')
  const kept: string[] = []
  let inLeadingDoc = false
  let sawCode = false
  let pendingComment: string[] = []

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      pendingComment = []
      continue
    }

    // The file's opening doc comment describes the module as a whole.
    if (!sawCode && DOC_COMMENT_START.test(line)) {
      inLeadingDoc = true
      kept.push(line)
      if (kept.join('\n').length >= maxChars) break
      continue
    }
    if (inLeadingDoc) {
      kept.push(line)
      if (/\*\/|"""|'''/.test(line)) inLeadingDoc = false
      if (kept.join('\n').length >= maxChars) break
      continue
    }

    if (IMPORT_LINE.test(line)) {
      sawCode = true
      pendingComment = []
      continue
    }

    if (DOC_COMMENT_START.test(line) || /^\s*(?:\/\/|#)/.test(line)) {
      pendingComment.push(line)
      if (pendingComment.length > 4) pendingComment.shift()
      continue
    }

    if (isDeclaration(line)) {
      sawCode = true
      kept.push(...pendingComment, line)
      pendingComment = []
      if (kept.join('\n').length >= maxChars) break
      continue
    }

    sawCode = true
    pendingComment = []
  }

  const out = kept.join('\n')
  if (!out.trim()) {
    // No declarations recognised — a config file, a script, an unfamiliar
    // language. Fall back to the head rather than contributing nothing.
    return content.slice(0, maxChars)
  }
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…` : out
}

export type CodeSelection = {
  files: string[]
  /** Files that matched but did not fit the cap. */
  skippedForCap: number
}

/**
 * Choose which of the candidate paths to distill.
 *
 * Shallower paths first, then alphabetical: top-level modules describe the
 * system, files buried deep are usually details. Deterministic so two runs
 * over an unchanged tree pick the same sample.
 */
export function selectSourceFiles(relPaths: readonly string[], maxFiles = 40): CodeSelection {
  const eligible = relPaths.filter(shouldIncludeSourceFile).sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length
    return depth !== 0 ? depth : a.localeCompare(b)
  })
  return {
    files: eligible.slice(0, maxFiles),
    skippedForCap: Math.max(0, eligible.length - maxFiles),
  }
}
