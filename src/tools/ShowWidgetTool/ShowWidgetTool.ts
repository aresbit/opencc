import { z } from 'zod/v4'
import {
  buildTool,
  type ToolDef,
  type ToolInputJSONSchema,
} from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, SHOW_WIDGET_TOOL_NAME } from './prompt.js'
import {
  buildArtifactFence,
  validateWidgetInput,
  WidgetValidationError,
} from './validation.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z
      .string()
      .describe('Short title shown with the artifact. Must not be empty.'),
    description: z
      .string()
      .optional()
      .describe('Optional one-sentence description of the artifact.'),
    widget_code: z
      .string()
      .describe(
        'Self-contained HTML or inline-SVG fragment. No document shell, external resources, or file references.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    title: z.string(),
    description: z.string().optional(),
    fence: z.string(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// Keep the result in the conversation even at ~1MB; below this threshold
// OpenCC replaces a large tool result with a short file preview.
const MAX_RESULT_SIZE_CHARS = 1_200_000

function renderToolUseMessage(input: Partial<Input>): string | null {
  const title = (input.title ?? '').trim().slice(0, 80)
  return title ? `show_widget "${title}"` : 'show_widget'
}

export const ShowWidgetTool = buildTool({
  name: SHOW_WIDGET_TOOL_NAME,
  searchHint: 'render a self-contained HTML or SVG visual artifact',
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema as unknown as ToolInputJSONSchema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ShowWidgetTool'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return `show_widget ${(input.title ?? '').trim()}`
  },
  renderToolUseMessage,
  async call(input, _context) {
    try {
      const { title, description, code } = validateWidgetInput(input)
      const fence = buildArtifactFence(title, description, code)
      return {
        data: {
          success: true,
          title,
          description: description || undefined,
          fence,
          message: fence,
        } satisfies Output,
      }
    } catch (error) {
      if (error instanceof WidgetValidationError) {
        return {
          data: {
            success: false,
            title: (input.title ?? '').trim(),
            description: (input.description ?? '').trim() || undefined,
            fence: '',
            message: error.message,
          } satisfies Output,
        }
      }
      throw error
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.fence
        : `show_widget failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
