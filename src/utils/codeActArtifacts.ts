/**
 * What the script left behind.
 *
 * CodeAct returns stdout and nothing else, which quietly decides what kind of
 * program is worth writing. A script that fits a model, renders a chart, emits
 * a CSV or writes a generated module has produced its real result as a *file* —
 * and on an ephemeral run that file is deleted moments later by the sandbox
 * cleanup, without ever being mentioned. The model then learns that producing
 * artifacts does not work, which is true, and stops trying.
 *
 * So: after execution and before cleanup, whatever the script created is
 * listed, and on an ephemeral run it is moved somewhere durable first. The
 * paths handed back are paths that still exist when the model reads them.
 */

import { copyFile, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { getCodeActBaseDir } from './codeActBuiltins.js'

export interface Artifact {
  /** Path relative to the sandbox, as the script would name it. */
  relPath: string
  /** Where it can actually be read now. */
  path: string
  bytes: number
}

export interface CollectOptions {
  /** Entries the runtime itself put there — builtins, the agent source, the binary. */
  managed: readonly string[]
  /** Stop walking after this many files; a runaway script should not hang the turn. */
  maxFiles?: number
  /** Directories deeper than this are summarised rather than walked. */
  maxDepth?: number
  /**
   * Only report files touched at or after this time.
   *
   * Required for a persistent sandbox, where everything from every previous run
   * is still sitting there: without it the manifest re-lists last week's output
   * on every call and stops meaning "what this run produced".
   */
  since?: number
}

const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_DEPTH = 6

export interface Collection {
  artifacts: Artifact[]
  /** True when the walk stopped early, so the list is partial. */
  truncated: boolean
}

/**
 * List files the script created inside its sandbox.
 *
 * Everything the runtime placed there is excluded by name: a listing whose top
 * entries are always `builtins/` and `agent.py` teaches the reader to skip it,
 * and then the one line that matters gets skipped too.
 */
export async function collectArtifacts(
  sandboxDir: string,
  options: CollectOptions,
): Promise<Collection> {
  const managed = new Set(options.managed)
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH

  const artifacts: Artifact[] = []
  let truncated = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (artifacts.length >= maxFiles) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (artifacts.length >= maxFiles) {
        truncated = true
        return
      }
      const full = join(dir, entry.name)
      const rel = relative(sandboxDir, full)
      // Managed entries are matched at the top level only, so a script's own
      // `output/agent.py` is still reported.
      if (depth === 0 && managed.has(entry.name)) continue
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) {
          truncated = true
          continue
        }
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        // Filesystem timestamps have coarse resolution on some platforms, so
        // allow a small slack rather than dropping a file written in the same
        // tick the run started.
        if (options.since !== undefined && info.mtimeMs < options.since - 1000) {
          continue
        }
        artifacts.push({
          relPath: rel.split(sep).join('/'),
          path: full,
          bytes: info.size,
        })
      } catch {
        // Vanished between readdir and stat — a script still writing. Skip it
        // rather than failing the whole collection.
      }
    }
  }

  await walk(sandboxDir, 0)
  artifacts.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { artifacts, truncated }
}

/** Durable home for artifacts rescued from an ephemeral sandbox. */
export function getArtifactsDir(): string {
  return join(getCodeActBaseDir(), 'artifacts')
}

/**
 * Move artifacts out of a sandbox that is about to be deleted.
 *
 * Rename first, copy as a fallback: the sandbox and the artifacts directory are
 * normally on the same filesystem, but a sandbox redirected elsewhere would
 * make rename fail with EXDEV, and losing the output at that point would be the
 * worst possible time to find out.
 */
export async function preserveArtifacts(
  artifacts: readonly Artifact[],
  runId: string,
): Promise<Artifact[]> {
  if (artifacts.length === 0) return []
  const destRoot = join(getArtifactsDir(), runId)
  const preserved: Artifact[] = []

  for (const artifact of artifacts) {
    const dest = join(destRoot, ...artifact.relPath.split('/'))
    try {
      await mkdir(join(dest, '..'), { recursive: true })
      try {
        await rename(artifact.path, dest)
      } catch {
        await copyFile(artifact.path, dest)
      }
      preserved.push({ ...artifact, path: dest })
    } catch {
      // Best effort: a file we cannot rescue is reported at its old path
      // rather than dropped, so the model at least knows it was produced.
      preserved.push(artifact)
    }
  }
  return preserved
}

/** Drop a preserved run's directory. */
export async function discardPreservedRun(runId: string): Promise<void> {
  await rm(join(getArtifactsDir(), runId), { recursive: true, force: true })
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Render the manifest.
 *
 * Only called when something was produced — an "Artifacts: none" line on every
 * run is noise that trains the reader to skip the section.
 */
export function renderArtifacts(
  artifacts: readonly Artifact[],
  truncated: boolean,
): string {
  if (artifacts.length === 0) return ''
  const lines = [
    `\n<!-- artifacts (${artifacts.length}) — files this run produced: -->`,
  ]
  for (const artifact of artifacts) {
    lines.push(`  ${artifact.relPath}  (${formatBytes(artifact.bytes)})  ${artifact.path}`)
  }
  if (truncated) {
    lines.push('  … more files were produced than are listed here.')
  }
  return lines.join('\n')
}
