/**
 * Action discovery — finds and parses executable scripts from ~/.claude/action/.
 *
 * Actions are code files (TypeScript, Python, Bash, C, C++, Rust, OCaml, Scheme) with YAML frontmatter
 * that describe their name, inputs, and behavior. Unlike Skills (prompt templates),
 * Actions are executed directly and return results in a single round-trip.
 *
 * File format:
 *   ---
 *   name: ytdlp
 *   description: Download video/audio via yt-dlp
 *   language: python
 *   ---
 *   (executable code follows)
 */

import { homedir } from 'os'
import { join, extname, basename } from 'path'
import { readFile, readdir } from 'fs/promises'
import { existsSync } from 'fs'

export type ActionLanguage =
  | 'typescript'
  | 'python'
  | 'bash'
  | 'c'
  | 'cpp'
  | 'rust'
  | 'ocaml'
  | 'scheme'

export interface ActionDef {
  name: string
  filePath: string
  language: ActionLanguage
  description: string
}

const EXTENSION_TO_LANGUAGE: Record<string, ActionLanguage> = {
  '.ts': 'typescript',
  '.py': 'python',
  '.sh': 'bash',
  '.c': 'c',
  '.cpp': 'cpp',
  '.rs': 'rust',
  '.ml': 'ocaml',
  '.scm': 'scheme',
}

const ACTION_LANGUAGES = new Set<ActionLanguage>(
  Object.values(EXTENSION_TO_LANGUAGE),
)

function isActionLanguage(value: string | undefined): value is ActionLanguage {
  return value !== undefined && ACTION_LANGUAGES.has(value as ActionLanguage)
}

function languageFromExt(path: string): ActionLanguage | null {
  const ext = extname(path).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] ?? null
}

function parseYamlFrontmatter(content: string, filePath: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') {
    return {
      frontmatter: {},
      body: content,
    }
  }

  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i
      break
    }
  }

  if (endIdx === -1) {
    return { frontmatter: {}, body: content }
  }

  const fm: Record<string, string> = {}
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      if (key && value) {
        fm[key] = value
      }
    }
  }

  const body = lines.slice(endIdx + 1).join('\n')
  return { frontmatter: fm, body }
}

export async function loadActionsFromDir(
  dir?: string,
): Promise<ActionDef[]> {
  const actionsDir = dir ?? join(homedir(), '.claude', 'action')

  if (!existsSync(actionsDir)) {
    return []
  }

  let entries: string[]
  try {
    entries = await readdir(actionsDir)
  } catch {
    return []
  }

  const actions: ActionDef[] = []

  for (const entry of entries) {
    const filePath = join(actionsDir, entry)
    const lang = languageFromExt(entry)

    if (!lang) continue // skip non-action files

    try {
      const content = await readFile(filePath, 'utf-8')
      const { frontmatter, body } = parseYamlFrontmatter(content, filePath)

      const name = frontmatter['name'] ?? basename(entry, extname(entry))
      const description = frontmatter['description'] ?? `${lang} script: ${name}`
      const declaredLang = frontmatter['language']

      actions.push({
        name,
        filePath,
        language: isActionLanguage(declaredLang) ? declaredLang : lang,
        description,
      })
    } catch {
      // Skip unreadable files
    }
  }

  return actions
}

/**
 * Get actions formatted for display in prompts.
 */
export async function getActionListing(): Promise<string> {
  const actions = await loadActionsFromDir()
  if (actions.length === 0) return ''

  const lines = actions.map(
    (a) => `- ${a.name} (${a.language}): ${a.description}`,
  )
  return `Available Actions in ~/.claude/action/:\n${lines.join('\n')}`
}
