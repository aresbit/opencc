/**
 * Which ast-grep language a file is, and where its tree-sitter grammar lives.
 *
 * Grammars are separate WebAssembly modules — `@ast-grep/wasm` ships the
 * matcher and no languages at all — so this table is also the list of what the
 * tool can actually parse. Adding a language is a row here plus a grammar in
 * `@vscode/tree-sitter-wasm`; nothing else changes.
 */

/** Language ids as ast-grep knows them, keyed by lowercase file extension. */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  cs: 'c_sharp',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  c: 'cpp',
  css: 'css',
  scss: 'css',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
}

/**
 * Grammar filename per language. Mostly `tree-sitter-<lang>.wasm`, but the
 * package names a few differently and a wrong guess fails at load rather than
 * at lookup, which is a much worse place to find out.
 */
const GRAMMAR_FILE: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
  c_sharp: 'tree-sitter-c-sharp.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  css: 'tree-sitter-css.wasm',
  bash: 'tree-sitter-bash.wasm',
}

/**
 * `$` is a valid identifier character in these languages, so ast-grep's
 * metavariable sigil has to be something else or `$FOO` in a pattern is
 * ambiguous with real source.
 */
const EXPANDO_CHAR: Record<string, string> = {
  bash: 'µ',
  php: 'µ',
}

export const SUPPORTED_LANGUAGES = Object.keys(GRAMMAR_FILE).sort()

/** The language for a path, or null when nothing here can parse it. */
export function languageForPath(filePath: string): string | null {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const lang = BY_EXTENSION[base.slice(dot + 1).toLowerCase()]
  return lang && GRAMMAR_FILE[lang] ? lang : null
}

export function grammarFile(language: string): string | null {
  return GRAMMAR_FILE[language] ?? null
}

export function expandoChar(language: string): string | undefined {
  return EXPANDO_CHAR[language]
}

/** Extensions this tool can parse, for handing to ripgrep as globs. */
export function extensionsForLanguages(languages: string[]): string[] {
  const wanted = new Set(languages)
  return Object.entries(BY_EXTENSION)
    .filter(([, lang]) => wanted.has(lang))
    .map(([ext]) => ext)
}
