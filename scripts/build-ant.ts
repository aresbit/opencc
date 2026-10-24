#!/usr/bin/env bun

import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from 'typescript'

type CliOptions = {
  keepTemp: boolean
  outDir?: string
  installDeps: boolean
}

type Span = { start: number; end: number }

const log = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

const logError = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

/**
 * Collect the build-time `("external" as string)` idiom only.
 *
 * The ant build needs to flip this literal so the bundler's constant folding
 * keeps the ANT-only branch. Rewriting every `'external'` string would also
 * corrupt unrelated runtime checks such as
 * `process.env.USER_TYPE === 'external'`, so match the exact idiom: a string
 * literal wrapped in `as string`.
 */
function collectExternalLiteralSpans(
  sourceFile: ts.SourceFile,
  spans: Span[],
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) &&
      node.text === 'external' &&
      ts.isAsExpression(node.parent) &&
      node.parent.type.kind === ts.SyntaxKind.StringKeyword
    ) {
      spans.push({ start: node.getStart(sourceFile), end: node.getEnd() })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function parseArgs(argv: string[]): CliOptions {
  let keepTemp = false
  let outDir: string | undefined
  let installDeps = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep-temp') {
      keepTemp = true
      continue
    }
    if (arg === '--install') {
      installDeps = true
      continue
    }
    if (arg === '--out-dir') {
      outDir = argv[i + 1]
      i += 1
      continue
    }
  }

  return { keepTemp, outDir, installDeps }
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}`)
  }
}

async function collectSourceFiles(srcRoot: string): Promise<string[]> {
  const files: string[] = []
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  for await (const file of glob.scan(srcRoot)) {
    files.push(join(srcRoot, file))
  }
  return files
}

async function transformSourceTree(
  projectRoot: string,
): Promise<{ found: number; replaced: number }> {
  const srcRoot = join(projectRoot, 'src')
  const files = await collectSourceFiles(srcRoot)
  let found = 0
  let replaced = 0

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const isTsx = file.endsWith('.tsx')
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const spans: Span[] = []
    collectExternalLiteralSpans(sourceFile, spans)
    found += spans.length

    if (spans.length === 0) continue

    // Apply replacements back-to-front so earlier offsets stay valid.
    let output = source
    const sorted = [...new Map(spans.map(s => [`${s.start}:${s.end}`, s])).values()].sort(
      (a, b) => b.start - a.start,
    )
    for (const span of sorted) {
      const literal = output.slice(span.start, span.end)
      if (literal !== '"external"' && literal !== "'external'") continue
      const quote = literal.startsWith("'") ? "'" : '"'
      output =
        output.slice(0, span.start) + `${quote}ant${quote}` + output.slice(span.end)
      replaced += 1
    }

    if (output !== source) {
      await writeFile(file, output, 'utf8')
    }
  }

  return { found, replaced }
}

async function copyProjectToTemp(srcRoot: string, targetRoot: string): Promise<void> {
  await cp(srcRoot, targetRoot, {
    recursive: true,
    preserveTimestamps: true,
    filter: from => {
      const rel = relative(srcRoot, from)
      if (rel === '') return true
      const top = rel.split('/')[0]
      if (top === '.git' || top === 'node_modules' || top === 'dist') {
        return false
      }
      return true
    },
  })
}

async function ensureNodeModules(tempRoot: string, srcRoot: string): Promise<void> {
  const target = join(tempRoot, 'node_modules')
  const source = join(srcRoot, 'node_modules')
  await symlink(source, target, 'dir')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const sourceRoot = process.cwd()
  const tempRoot =
    options.outDir ??
    (await mkdtemp(join(tmpdir(), 'opencc-ant-build-')))

  if (options.outDir) {
    await rm(tempRoot, { recursive: true, force: true })
    await mkdir(tempRoot, { recursive: true })
  }

  log(`[build-ant] source: ${sourceRoot}`)
  log(`[build-ant] temp:   ${tempRoot}`)

  await copyProjectToTemp(sourceRoot, tempRoot)

  if (options.installDeps) {
    await run(['bun', 'install'], tempRoot)
  } else {
    await ensureNodeModules(tempRoot, sourceRoot)
  }

  const { found, replaced } = await transformSourceTree(tempRoot)
  log(`[build-ant] ant-only literals: found ${found}, replaced ${replaced}`)
  if (found !== replaced) {
    throw new Error(
      `Refusing to build: ${found - replaced} ant-only literals were not rewritten`,
    )
  }

  await run(['bun', 'run', 'build'], tempRoot)
  log(`[build-ant] build output: ${join(tempRoot, 'dist')}`)

  if (!options.keepTemp && !options.outDir) {
    await rm(tempRoot, { recursive: true, force: true })
    log('[build-ant] temp directory removed')
  } else {
    log('[build-ant] temp directory retained')
  }
}

void main().catch(error => {
  logError(`[build-ant] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
