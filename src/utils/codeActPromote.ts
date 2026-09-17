/**
 * Turning a script that worked into one you can use again.
 *
 * The reuse machinery was already here and already wired: `~/.claude/action/`
 * is copied into every CodeAct sandbox as `actions/` on every single run, so
 * anything living there is importable by every future script. It went unused
 * because nothing pointed at it. The language hints injected at the top of each
 * program mention `builtins/` and never mention `actions/`; the only reference
 * anywhere was the closing sentence of the `persistKey` parameter description,
 * which a model reads only if it already decided to want a persistent sandbox.
 * And there was no way to put a file there short of guessing the path and
 * calling Write.
 *
 * So every run started from nothing. A script that solved a problem on Tuesday
 * was retyped on Wednesday, and the fact that it had once worked was not
 * recorded anywhere.
 *
 * Promotion closes that loop in one call: the source goes to `actions/` where
 * future runs will find it, a SKILL.md goes to the user skill store so the
 * work is addressable by name rather than by remembering it exists, and the
 * skill is hot-loaded so it is usable in the same session that wrote it.
 */

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'

/** Scripts copied into every CodeAct sandbox as `actions/`. */
export function getActionsDir(): string {
  return join(homedir(), '.claude', 'action')
}

/** The user skill store, scanned at startup (flat, one level). */
export function getSkillStoreDir(): string {
  return join(getClaudeConfigHomeDir(), 'skills')
}

/** Inline the source into SKILL.md below this size; above it, point at the file. */
const INLINE_SOURCE_LIMIT = 8_000

/**
 * How a later program in each language reaches a promoted script.
 *
 * Every one of these was verified by promoting a library and then having a
 * separate run import it: all four work, and no two look alike. Rust needs a
 * `#[path]` attribute because rustc compiles a single file; Python needs the
 * directory on sys.path because `actions/` is not a package; C includes the
 * source outright. A model will not guess `#[path]`, so a SKILL.md that says
 * only "import it" is a SKILL.md nobody can act on.
 */
const REUSE_SNIPPET: Record<string, (dir: string, file: string) => string> = {
  typescript: (dir, file) => `import { something } from './${dir}/${file}'`,
  python: (dir, file) =>
    `import sys\nsys.path.insert(0, '${dir}')\nfrom ${file.replace(/\.py$/, '')} import something`,
  rust: (dir, file) => `#[path = "${dir}/${file}"]\nmod promoted;\n// then: promoted::something()`,
  c: (dir, file) => `#include "${dir}/${file}"`,
  cpp: (dir, file) => `#include "${dir}/${file}"`,
  bash: (dir, file) => `source "${dir}/${file}"`,
  ocaml: (dir, file) => `(* pass ${dir}/${file} to the compiler, or inline what you need *)`,
  scheme: (dir, file) => `(load "${dir}/${file}")`,
}

export interface PromoteOptions {
  /** Slug for the action and the skill. */
  name: string
  /** One line, shown in the skill listing. Keep under ~250 characters. */
  description: string
  /** The program to keep. */
  sourcePath: string
  language: string
  /** Sandbox to pin, when the script needs installed dependencies to run. */
  persistKey?: string
}

export interface PromoteResult {
  name: string
  actionPath: string
  skillPath: string
  skillName: string
}

/**
 * Slug rules are the skill loader's, not ours: the store is scanned one level
 * deep and the directory name becomes the skill name, so anything that is not
 * a plain lowercase identifier either fails to load or loads under a name
 * nobody can type.
 */
export function slugForPromotion(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!slug) throw new Error(`Cannot derive a usable name from "${raw}"`)
  return slug
}

function buildSkillMarkdown(opts: {
  name: string
  description: string
  language: string
  scriptRelPath: string
  source: string
  persistKey?: string
}): string {
  const { name, description, language, scriptRelPath, persistKey } = opts
  const inline = opts.source.length <= INLINE_SOURCE_LIMIT

  const sandboxNote = persistKey
    ? `\nThis script needs its sandbox: run it with \`persistKey: "${persistKey}"\` so the dependencies installed for it are still there.\n`
    : ''

  const body = inline
    ? `## Source\n\n\`\`\`${language}\n${opts.source}\n\`\`\`\n`
    : `## Source\n\nToo long to inline. Read it at \`${join(getActionsDir(), name, scriptRelPath)}\`, or from inside a run at \`actions/${name}/${scriptRelPath}\`.\n`

  const snippet = (REUSE_SNIPPET[language] ?? REUSE_SNIPPET.typescript!)(
    `actions/${name}`,
    scriptRelPath,
  )

  return `---
name: ${name}
description: ${description}
---

# ${name}

${description}

## How to use it

The script lives in \`~/.claude/action/${name}/\`, which every CodeAct run copies
into its sandbox. From inside a new ${language} program, reach it like this:

\`\`\`${language}
${snippet}
\`\`\`
${sandboxNote}
To run it unchanged, read that file and pass its contents as \`code\` with
\`language: "${language}"\`.

${body}`
}

/**
 * Write the script where future runs will find it, register a skill for it,
 * and return where both landed.
 *
 * Deliberately not idempotent-by-refusal: promoting the same name again
 * overwrites. A script is promoted after it works, and the second version of
 * a script is usually the one worth keeping — refusing would make improving a
 * promoted script harder than promoting it in the first place.
 */
export async function promoteRun(
  options: PromoteOptions,
): Promise<PromoteResult> {
  const name = slugForPromotion(options.name)
  const source = await readFile(options.sourcePath, 'utf8')
  const scriptRelPath = basename(options.sourcePath)

  const actionDir = join(getActionsDir(), name)
  // Clear first. Overwriting by copyFile only replaces a file of the SAME name,
  // so promoting `csv-summary` in Python and then in Rust left agent.py sitting
  // there as an orphan: nothing referenced it, the SKILL.md described the Rust
  // one, and nothing would ever clean it up. Re-promoting means replacing.
  await rm(actionDir, { recursive: true, force: true })
  await mkdir(actionDir, { recursive: true })
  await copyFile(options.sourcePath, join(actionDir, scriptRelPath))

  const skillDir = join(getSkillStoreDir(), name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, 'SKILL.md'),
    buildSkillMarkdown({
      name,
      description: options.description,
      language: options.language,
      scriptRelPath,
      source,
      persistKey: options.persistKey,
    }),
    'utf8',
  )

  return {
    name,
    actionPath: join(actionDir, scriptRelPath),
    skillPath: skillDir,
    skillName: name,
  }
}

/** Promoted scripts, so the model can see what it already has. */
export async function listPromoted(): Promise<
  Array<{ name: string; description: string }>
> {
  const store = getSkillStoreDir()
  const entries = await readdir(store).catch(() => [] as string[])
  const found: Array<{ name: string; description: string }> = []
  for (const entry of entries) {
    try {
      const content = await readFile(join(store, entry, 'SKILL.md'), 'utf8')
      const match = content.match(/^description:\s*(.+)$/m)
      found.push({ name: entry, description: match?.[1]?.trim() ?? '' })
    } catch {
      // Not a skill directory, or unreadable. Listing should not fail for it.
    }
  }
  return found
}
