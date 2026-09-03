/**
 * ast-grep, compiled to WebAssembly, booted once per process.
 *
 * Two things here are not obvious.
 *
 * First, the module cannot simply be imported. `@ast-grep/wasm`'s entry does
 * `import * as wasm from "./wasm_bg.wasm"` — the wasm-ESM integration that
 * wasm-bindgen emits for bundler targets — and under Bun that import yields an
 * object without `__wbindgen_start`, so the entry throws on load. Instantiating
 * by hand against the same JS glue is the supported shape underneath, and the
 * import name is read off the compiled module rather than hardcoded so a
 * wasm-bindgen rename fails loudly here instead of silently later.
 *
 * Second, grammars are per-language WebAssembly of their own and are loaded on
 * first use, not up front. Registering everything would mean paying 22 MB of
 * parsers to answer a question about one Go file; TypeScript alone is 1.4 MB
 * and C++ is 5.2 MB.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import { expandoChar, grammarFile } from './languages.js'

export type SgNode = {
  text(): string
  kind(): string
  range(): {
    start: { line: number; column: number; index: number }
    end: { line: number; column: number; index: number }
  }
  getMatch(name: string): SgNode | undefined
  find(matcher: unknown): SgNode | undefined
  findAll(matcher: unknown): SgNode[]
  replace(text: string): { start_pos: number; end_pos: number; inserted_text: string }
  commitEdits(edits: unknown): string
}

type AstGrepModule = {
  initializeTreeSitter(): Promise<void>
  registerDynamicLanguage(
    map: Record<string, { libraryPath: string; expandoChar?: string }>,
  ): Promise<void>
  parse(lang: string, src: string): { root(): SgNode }
  dumpPattern(lang: string, pattern: string): { kind?: string } | undefined
  __wbg_set_wasm(exports: unknown): void
}

export class AstGrepUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AstGrepUnavailableError'
  }
}

const require_ = createRequire(import.meta.url)

/**
 * Resolved at runtime rather than imported, for the same reason the ripgrep
 * shim is: a static import lets the bundler inline the package, after which
 * any path the package computes from its own location points into `dist/`.
 */
function resolvePackageDir(specifier: string): string | null {
  try {
    return dirname(require_.resolve(specifier))
  } catch {
    return null
  }
}

let booted: Promise<AstGrepModule> | null = null

async function boot(): Promise<AstGrepModule> {
  const glue = (await import('@ast-grep/wasm/wasm_bg.js')) as unknown as AstGrepModule
  const dir = resolvePackageDir('@ast-grep/wasm/wasm_bg.js')
  if (!dir) {
    throw new AstGrepUnavailableError(
      '@ast-grep/wasm is not installed; structural search is unavailable',
    )
  }
  const binary = join(dir, 'wasm_bg.wasm')
  if (!existsSync(binary)) {
    throw new AstGrepUnavailableError(`@ast-grep/wasm is installed but ${binary} is missing`)
  }

  const compiled = await WebAssembly.compile(readFileSync(binary))
  // The glue is supplied under whatever name the module imports it by. Reading
  // it back beats hardcoding './wasm_bg.js': if wasm-bindgen changes the name,
  // a missing-import error names the problem, where a hardcoded key would
  // instead produce a LinkError about every function at once.
  const importNames = new Set(WebAssembly.Module.imports(compiled).map(i => i.module))
  const imports: Record<string, unknown> = {}
  for (const name of importNames) imports[name] = glue
  const instance = await WebAssembly.instantiate(compiled, imports as never)

  glue.__wbg_set_wasm(instance.exports)
  const start = (instance.exports as Record<string, unknown>).__wbindgen_start
  if (typeof start === 'function') (start as () => void)()

  // web-tree-sitter finds its own `web-tree-sitter.wasm` relative to the
  // module that loaded it. Bundled, that is `dist/cli.js`, so it looks beside
  // the bundle and is not there. Emscripten aborts asynchronously, which
  // `initializeTreeSitter()` does not surface — the search then returned zero
  // matches and looked like a successful "nothing found", which is the worst
  // shape this failure could take. Initializing it here first, with an
  // explicit path into the installed package, means the bundle behaves the
  // same as the source tree.
  await initTreeSitterRuntime()

  await glue.initializeTreeSitter()
  return glue
}

async function initTreeSitterRuntime(): Promise<void> {
  const { Parser } = (await import('web-tree-sitter')) as {
    Parser: { init(options?: Record<string, unknown>): Promise<void> }
  }
  const dir = resolvePackageDir('web-tree-sitter')
  if (!dir) {
    throw new AstGrepUnavailableError(
      'web-tree-sitter is not installed; structural search cannot start',
    )
  }
  const runtime = join(dir, 'web-tree-sitter.wasm')
  if (!existsSync(runtime)) {
    throw new AstGrepUnavailableError(
      `web-tree-sitter is installed but ${runtime} is missing`,
    )
  }
  await Parser.init({
    locateFile: (name: string) => (name.endsWith('.wasm') ? runtime : join(dir, name)),
  })
}

export function loadAstGrep(): Promise<AstGrepModule> {
  booted ??= boot().catch(error => {
    // Don't cache a rejected promise: a failure caused by a half-finished
    // install should not poison the process for its whole lifetime.
    booted = null
    throw error
  })
  return booted
}

const registered = new Set<string>()
const registering = new Map<string, Promise<void>>()

/** Grammar directory, from the package that ships the prebuilt parsers. */
function grammarDir(): string | null {
  const dir = resolvePackageDir('@vscode/tree-sitter-wasm/package.json')
  return dir ? join(dir, 'wasm') : null
}

/**
 * Load a language's grammar, once. Concurrent callers for the same language
 * share one registration — `registerDynamicLanguage` is a wasm-side mutation
 * and two in flight for one language is a race worth not having.
 */
export async function ensureLanguage(language: string): Promise<void> {
  if (registered.has(language)) return
  const inFlight = registering.get(language)
  if (inFlight) return inFlight

  const promise = (async () => {
    const file = grammarFile(language)
    if (!file) {
      throw new AstGrepUnavailableError(`no grammar is configured for ${language}`)
    }
    const dir = grammarDir()
    if (!dir) {
      throw new AstGrepUnavailableError(
        '@vscode/tree-sitter-wasm is not installed; no language grammars are available',
      )
    }
    const libraryPath = join(dir, file)
    if (!existsSync(libraryPath)) {
      throw new AstGrepUnavailableError(`grammar for ${language} is missing at ${libraryPath}`)
    }
    const sg = await loadAstGrep()
    const expando = expandoChar(language)
    await sg.registerDynamicLanguage({
      [language]: expando ? { libraryPath, expandoChar: expando } : { libraryPath },
    })
    registered.add(language)
    logForDebugging(`ast-grep: registered grammar for ${language}`)
  })()
    .finally(() => registering.delete(language))

  registering.set(language, promise)
  return promise
}

/** Parse one source string. The grammar is loaded on demand. */
export async function parseSource(
  language: string,
  source: string,
): Promise<{ root(): SgNode }> {
  await ensureLanguage(language)
  const sg = await loadAstGrep()
  return sg.parse(language, source)
}

/**
 * Why a pattern will never match, or null if it is fine.
 *
 * `findAll` with an unparseable pattern does not throw — it returns no matches,
 * which is indistinguishable from "your codebase has none of these" and is the
 * most expensive way for this tool to be wrong. `dumpPattern` parses the
 * pattern on its own and reports an `ERROR` root when it did not survive, so
 * the two cases can be told apart before any file is read.
 */
export async function patternProblem(
  language: string,
  pattern: string,
): Promise<string | null> {
  await ensureLanguage(language)
  const sg = await loadAstGrep()
  try {
    const dumped = sg.dumpPattern(language, pattern)
    if (dumped?.kind === 'ERROR') {
      return `the pattern does not parse as ${language}; it matches nothing as written`
    }
    return null
  } catch (error) {
    return (error as Error).message
  }
}

/** Test seam: forget the booted module and every registered grammar. */
export function resetAstGrepForTesting(): void {
  booted = null
  registered.clear()
  registering.clear()
}
