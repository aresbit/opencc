/**
 * Tool-name length policy.
 *
 * Providers cap `tools[i].name`, and an over-long name does not degrade — it
 * fails the whole request with a hard 400 that never reaches the model:
 *
 *   Invalid 'tools[69].name': string too long. Expected a string with maximum
 *   length 128, but got a string with length 153 instead.
 *
 * OpenAI-compatible endpoints are stricter still (`function.name` <= 64, see
 * buildMcpToolName in services/mcp/mcpStringUtils.ts). Both are unrecoverable
 * for the session, so any name we generate at runtime goes through
 * clampToolName() before it enters the tool table.
 *
 * The truncation keeps a readable prefix and appends a content hash so two
 * different long names cannot collapse into one after truncation — the tool
 * pool dedupes by name (mergeAndFilterTools), so a collision would silently
 * drop a tool.
 */

import { createHash } from 'crypto'

/** Budget for names we generate ourselves — the provider-compatible floor. */
export const MAX_TOOL_NAME_LENGTH = 64

/** Hard cap enforced by the Anthropic API; anything longer is a 400. */
export const API_TOOL_NAME_LIMIT = 128

/** Length of the `_` + 8 hex chars appended when a name is truncated. */
const HASH_SUFFIX_LENGTH = 9

/**
 * Shorten `name` to at most `max` characters, preserving uniqueness.
 *
 * Names within budget are returned unchanged, so this is safe to apply
 * unconditionally. Longer names keep as much of the prefix as the budget
 * allows, plus a 8-hex-char digest of the full original name as a suffix.
 */
export function clampToolName(
  name: string,
  max: number = MAX_TOOL_NAME_LENGTH,
): string {
  if (name.length <= max) return name

  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  const keep = Math.max(1, max - HASH_SUFFIX_LENGTH)
  return `${name.slice(0, keep)}_${hash}`
}
