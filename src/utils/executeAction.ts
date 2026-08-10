/**
 * Action execution engine — loads and runs Action scripts via the CodeAct sandbox.
 *
 * Actions are persistent, reusable scripts in ~/.claude/action/.
 * Unlike Skills (prompt templates the model reads and follows step-by-step),
 * Actions execute directly and return results in a single call.
 */

import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { type ActionDef, loadActionsFromDir } from './loadActionsDir.js'
import { executeCodeActCode, type CodeActLanguage } from './codeActSandbox.js'

export interface ActionResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  actionName: string
}

/**
 * Execute an Action by name. Looks up the action file in ~/.claude/action/,
 * reads its code, strips YAML frontmatter, and executes via CodeAct sandbox.
 */
export async function executeAction(
  actionName: string,
  args?: Record<string, string>,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    cwd?: string
  },
): Promise<ActionResult> {
  const actions = await loadActionsFromDir()
  const actionDef = actions.find((a) => a.name === actionName)

  if (!actionDef) {
    const available = actions.map((a) => a.name).join(', ')
    return {
      success: false,
      stdout: '',
      stderr: `Unknown action: ${actionName}. Available: ${available}`,
      exitCode: -1,
      actionName,
    }
  }

  return executeActionDef(actionDef, args, options)
}

/**
 * Execute an Action from its definition.
 */
export async function executeActionDef(
  actionDef: ActionDef,
  args?: Record<string, string>,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    cwd?: string
  },
): Promise<ActionResult> {
  // Read the action script
  let rawCode: string
  try {
    rawCode = await readFile(actionDef.filePath, 'utf-8')
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: `Failed to read action file: ${actionDef.filePath}`,
      exitCode: -1,
      actionName: actionDef.name,
    }
  }

  // Strip YAML frontmatter to get pure code
  const code = stripFrontmatter(rawCode)

  // Inject args as environment variables
  const injectedCode = injectArgs(code, args, actionDef.language)

  // Execute via CodeAct sandbox
  const result = await executeCodeActCode(injectedCode, {
    language: actionDef.language as CodeActLanguage,
    timeoutMs: options?.timeoutMs ?? 300_000,
    signal: options?.signal,
    cwd: options?.cwd,
    environment: args ? { ACTION_ARGS: JSON.stringify(args) } : undefined,
  })

  return {
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    actionName: actionDef.name,
  }
}

function stripFrontmatter(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return content

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines.slice(i + 1).join('\n')
    }
  }
  return content
}

function injectArgs(
  code: string,
  args: Record<string, string> | undefined,
  lang: ActionDef['language'],
): string {
  if (!args || Object.keys(args).length === 0) return code

  switch (lang) {
    case 'python':
      return `import os, json as _json
_ACTION_ARGS = _json.loads(os.environ.get('ACTION_ARGS', '{}'))
${code}`

    case 'typescript':
      return `const _ACTION_ARGS = JSON.parse(process.env.ACTION_ARGS || '{}');
${code}`

    case 'bash':
      return `# ACTION_ARGS is available as JSON in $ACTION_ARGS
${code}`

    case 'rust':
      return `// ACTION_ARGS is available as JSON in the ACTION_ARGS environment variable.
${code}`

    case 'ocaml':
      return `(* ACTION_ARGS is available as JSON in the ACTION_ARGS environment variable. *)
${code}`

    case 'scheme':
      return `;; ACTION_ARGS is available as JSON in the ACTION_ARGS environment variable.
${code}`

    default:
      return code
  }
}
