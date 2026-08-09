#!/usr/bin/env node

/**
 * Replace decompiler-generated duplicate modules with forwarding modules.
 *
 * The decompiled sources contain imports such as `./src/utils/cwd.js` from
 * feature-specific directories. The old type-error repair script satisfied
 * those imports by creating no-op modules, even when the real implementation
 * already existed at `src/utils/cwd.ts`. Those no-ops become runtime failures
 * as soon as a feature is enabled.
 *
 * This script only rewrites an auto-generated stub when the suffix following
 * its last `/src/` resolves to a non-stub module below the repository's root
 * `src/` directory. Ambiguous or unresolved stubs are reported and left alone.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDir, '..')
const sourceRoot = resolve(repositoryRoot, 'src')
const STUB_HEADER = /^\/\/ Auto-generated (?:type )?stub\b/
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

async function exists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function collectSourceFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await collectSourceFiles(path, output)
    } else if (SOURCE_EXTENSIONS.includes(extname(entry.name))) {
      output.push(path)
    }
  }
  return output
}

async function isGeneratedStub(path) {
  return STUB_HEADER.test(await readFile(path, 'utf8'))
}

function candidatePaths(path) {
  const extension = extname(path)
  const stem = extension ? path.slice(0, -extension.length) : path
  return [
    path,
    ...SOURCE_EXTENSIONS.map(candidateExtension => stem + candidateExtension),
    ...SOURCE_EXTENSIONS.map(candidateExtension =>
      resolve(stem, `index${candidateExtension}`),
    ),
  ]
}

async function resolveCanonicalModule(stubPath) {
  const relativePath = relative(repositoryRoot, stubPath)
  const marker = `${sep}src${sep}`
  const markerIndex = relativePath.lastIndexOf(marker)
  if (markerIndex < 0) return undefined

  const suffix = relativePath.slice(markerIndex + marker.length)
  for (const candidate of candidatePaths(resolve(sourceRoot, suffix))) {
    if (
      candidate !== stubPath &&
      (await exists(candidate)) &&
      !(await isGeneratedStub(candidate))
    ) {
      return candidate
    }
  }
  return undefined
}

function moduleSpecifier(fromPath, targetPath) {
  let specifier = relative(dirname(fromPath), targetPath).split(sep).join('/')
  if (!specifier.startsWith('.')) specifier = `./${specifier}`
  return specifier.replace(/\.(?:ts|tsx|jsx)$/, '.js')
}

const files = await collectSourceFiles(sourceRoot)
let restored = 0
let unresolved = 0

for (const stubPath of files) {
  const original = await readFile(stubPath, 'utf8')
  if (!STUB_HEADER.test(original)) continue

  const targetPath = await resolveCanonicalModule(stubPath)
  if (!targetPath) {
    unresolved += 1
    continue
  }

  const specifier = moduleSpecifier(stubPath, targetPath)
  const target = await readFile(targetPath, 'utf8')
  const lines = [
    '// Forward to the canonical module; restored from a decompiler-generated stub.',
    `export * from '${specifier}'`,
  ]

  if (/\bexport\s+default\b/.test(original)) {
    if (!/\bexport\s+default\b|\bas\s+default\b/.test(target)) {
      throw new Error(
        `${relative(repositoryRoot, stubPath)} needs a default export, but ` +
          `${relative(repositoryRoot, targetPath)} does not provide one`,
      )
    }
    lines.push(`export { default } from '${specifier}'`)
  }

  await writeFile(stubPath, `${lines.join('\n')}\n`)
  restored += 1
}

console.log(`Restored ${restored} generated stubs from canonical modules.`)
console.log(`Left ${unresolved} generated stubs for manual review.`)
