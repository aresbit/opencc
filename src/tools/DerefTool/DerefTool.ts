/**
 * Deref — the recovery path for handle-ized tool results.
 *
 * contextHandleHook replaces any tool result over its threshold with a
 * handle plus a preview, and contextShuntHook replaces the preview with a
 * worker-model summary. Both tell the model the full text stays retrievable.
 * Nothing made that true: `deref()` was exported from a module barrel and
 * from nowhere the model could reach, so on the shipped default configuration
 * every large result had its content removed from context with no way back —
 * narrowing that had become deletion, described as lossless. The evaluation
 * harness scored those facts `recoverable` because it calls deref() directly,
 * which is exactly why a missing tool did not show up as information loss.
 *
 * This tool is that path, and it is deliberately the whole of it: reading
 * session memory, no filesystem or network access, no side effects beyond
 * counting the dereference (which is what getHandleUtilization measures).
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  deref,
  describeHandle,
  listHandles,
} from '../../services/functionHooks/plugins/contextHandleHook.js'
import { DEREF_TOOL_NAME, DESCRIPTION } from './prompt.js'
import { renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    handle: z
      .string()
      .describe('The handle id, e.g. "res_0007_a1b2" — the text inside [handle:...]'),
    start_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('First line to return, 1-based and inclusive. Defaults to 1.'),
    end_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Last line to return, 1-based and inclusive. Defaults to the last line.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    handle: z.string(),
    start_line: z.number(),
    end_line: z.number(),
    total_lines: z.number(),
    content: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const DerefTool = buildTool({
  name: DEREF_TOOL_NAME,
  searchHint: 'read exact lines behind a [handle:...] reference',
  userFacingName: () => 'Deref',
  maxResultSizeChars: 400_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Reads a Map this process already holds. No I/O, no mutation of anything
  // outside the handle's own deref counter.
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return String(input.handle ?? '')
  },
  async description() {
    return 'Read exact lines from a handle-ized tool result'
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.content,
    }
  },
  async call({ handle, start_line, end_line }) {
    const meta = describeHandle(handle)
    if (!meta) {
      const available = listHandles()
      throw new Error(
        available.length === 0
          ? `No such handle "${handle}". No handles are live in this session — re-run the tool that produced the content.`
          : `No such handle "${handle}" (it may have been evicted). Live handles: ${available
              .map(h => `${h.handle} (${h.tool}, ${h.lines} lines)`)
              .join(', ')}`,
      )
    }

    // Clamping rather than rejecting: a summary can point just past the end of
    // a file, and returning the lines that do exist is more useful than an
    // error the model has to recover from. The echoed range says what was
    // actually returned.
    const from = Math.max(1, start_line ?? 1)
    const to = Math.min(meta.lines, end_line ?? meta.lines)
    const content = deref(handle, from, to) ?? ''

    return {
      data: {
        handle,
        start_line: from,
        end_line: Math.max(from - 1, to),
        total_lines: meta.lines,
        content,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
