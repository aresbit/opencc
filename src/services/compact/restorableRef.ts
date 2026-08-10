// Tool names are inlined rather than imported: importing them pulls the whole
// tool graph (and lodash) into the compact layer, which is the same circular
// dependency this directory already works around for the cleared-message
// constant. These are the user-facing tool names and change rarely; an
// unrecognised name is handled by the generic branch below rather than lost.
// Source of truth: FileReadTool/prompt.ts, FileEditTool/constants.ts,
// FileWriteTool/prompt.ts, GlobTool/prompt.ts, GrepTool/prompt.ts,
// WebFetchTool/prompt.ts, WebSearchTool/prompt.ts.
const FILE_READ_TOOL_NAME = 'Read'
const FILE_EDIT_TOOL_NAME = 'Edit'
const FILE_WRITE_TOOL_NAME = 'Write'
const GLOB_TOOL_NAME = 'Glob'
const GREP_TOOL_NAME = 'Grep'
const WEB_FETCH_TOOL_NAME = 'WebFetch'
const WEB_SEARCH_TOOL_NAME = 'WebSearch'

/**
 * Restorable compression for cleared tool results.
 *
 * Microcompaction reclaims context by replacing old tool results with a
 * placeholder. The placeholder used to be a bare sentinel — "[Old tool result
 * content cleared]" — which throws away the one thing that makes the drop
 * reversible: *what was read*. The model looking at that line cannot tell
 * whether it lost a file, a command, or a web page, so its options are to
 * re-derive the reference by correlating tool_use_id back through the
 * transcript, or to redo the exploration blind.
 *
 * Keeping the reference costs a few tokens and turns an irreversible drop into
 * a pointer: the content is gone, the address is not, and re-reading is one
 * call away. This is the "compression must be restorable" property — drop a
 * page's body but keep its URL, drop a file's contents but keep its path.
 */

/** Stable prefix so a cleared placeholder is recognisable across variants. */
export const CLEARED_PREFIX = '[cleared'

/** Fallback when no reference can be derived from the tool input. */
export const CLEARED_FALLBACK = '[Old tool result content cleared]'

/** True for any placeholder this module produces, plus the legacy sentinel. */
export function isClearedPlaceholder(content: unknown): boolean {
  if (typeof content !== 'string') return false
  return content === CLEARED_FALLBACK || content.startsWith(CLEARED_PREFIX)
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`
}

function field(input: unknown, ...keys: string[]): string | null {
  if (!input || typeof input !== 'object') return null
  for (const key of keys) {
    const value = str((input as Record<string, unknown>)[key])
    if (value) return value
  }
  return null
}

/**
 * Render the address of a cleared tool result, plus how to get it back.
 * Returns null when the input carries nothing worth pointing at, in which case
 * the caller should fall back to the bare sentinel.
 */
export function buildRestorableRef(
  toolName: string,
  input: unknown,
): string | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const path = field(input, 'file_path', 'path')
      if (!path) return null
      return `${CLEARED_PREFIX}: Read ${truncate(path, 200)} — re-read the file if you need it]`
    }

    case FILE_EDIT_TOOL_NAME:
    case FILE_WRITE_TOOL_NAME: {
      const path = field(input, 'file_path', 'path')
      if (!path) return null
      // The edit already landed; what was dropped is only the confirmation.
      return `${CLEARED_PREFIX}: ${toolName} ${truncate(path, 200)} — the change was applied; re-read the file to see its current state]`
    }

    case GREP_TOOL_NAME: {
      const pattern = field(input, 'pattern')
      if (!pattern) return null
      const where = field(input, 'path', 'glob')
      return `${CLEARED_PREFIX}: Grep ${JSON.stringify(truncate(pattern, 120))}${
        where ? ` in ${truncate(where, 120)}` : ''
      } — re-run the search if you need the matches]`
    }

    case GLOB_TOOL_NAME: {
      const pattern = field(input, 'pattern')
      if (!pattern) return null
      const where = field(input, 'path')
      return `${CLEARED_PREFIX}: Glob ${truncate(pattern, 120)}${
        where ? ` in ${truncate(where, 120)}` : ''
      } — re-run if you need the file list]`
    }

    case WEB_FETCH_TOOL_NAME: {
      const url = field(input, 'url')
      if (!url) return null
      return `${CLEARED_PREFIX}: WebFetch ${truncate(url, 300)} — re-fetch if you need the page]`
    }

    case WEB_SEARCH_TOOL_NAME: {
      const query = field(input, 'query')
      if (!query) return null
      return `${CLEARED_PREFIX}: WebSearch ${JSON.stringify(truncate(query, 160))} — re-run if you need the results]`
    }

    default: {
      // Shell tools vary by platform (Bash / PowerShell / …) but all carry the
      // command, which is the whole address of the observation.
      const command = field(input, 'command')
      if (command) {
        return `${CLEARED_PREFIX}: ${toolName} ${JSON.stringify(truncate(command, 200))} — re-run if you need the output]`
      }
      const path = field(input, 'file_path', 'path', 'url')
      if (path) {
        return `${CLEARED_PREFIX}: ${toolName} ${truncate(path, 200)} — re-run if you need it]`
      }
      return null
    }
  }
}

/**
 * The placeholder to substitute for a cleared result: the restorable reference
 * when one can be derived, the bare sentinel otherwise.
 */
export function clearedPlaceholder(
  toolName: string | undefined,
  input: unknown,
): string {
  if (!toolName) return CLEARED_FALLBACK
  return buildRestorableRef(toolName, input) ?? CLEARED_FALLBACK
}
