import { z } from 'zod/v4'
import {
  buildTool,
  type ToolDef,
  type ToolInputJSONSchema,
} from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  IMAGINE_MODULE_NAMES,
  imaginePlatformWidth,
  type ImagineModule,
  type ImaginePlatform,
  renderImagineModules,
} from './imaginePrompt.js'
import { DESCRIPTION, getPrompt, READ_ME_TOOL_NAME } from './prompt.js'

const MODULES = [...IMAGINE_MODULE_NAMES] as [ImagineModule, ...ImagineModule[]]
const PLATFORMS = ['mobile', 'desktop', 'unknown'] as const

const moduleEnum = z.enum(MODULES)

const inputSchema = lazySchema(() =>
  z.strictObject({
    modules: z
      .union([moduleEnum, z.array(moduleEnum).min(1)])
      .optional()
      .default('diagram')
      .describe(
        'One Imagine module or an array of modules. diagram, mockup, interactive, data_viz, art, chart, elicitation.',
      ),
    platform: z
      .enum(PLATFORMS)
      .optional()
      .default('desktop')
      .describe(
        'Target viewport: mobile (380px), desktop (680px), or unknown (desktop-first, 680px).',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    modules: z.array(z.string()),
    platform: z.string(),
    width: z.number(),
    text: z.string(),
    message: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function normalizeModules(value: Input['modules']): ImagineModule[] {
  return Array.isArray(value) ? [...value] : [value]
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  const modules = normalizeModules(input.modules ?? 'diagram')
  const platform = input.platform ?? 'desktop'
  return `read_me ${modules.join(',')} (${platform})`
}

export const ReadMeTool = buildTool({
  name: READ_ME_TOOL_NAME,
  searchHint: 'read Imagine visual module guidance before rendering',
  maxResultSizeChars: 128_000,
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
    return 'ReadMeTool'
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
    return `read_me ${normalizeModules(input.modules ?? 'diagram').join(',')} ${input.platform ?? 'desktop'}`
  },
  renderToolUseMessage,
  async call(input, _context) {
    const modules = normalizeModules(input.modules ?? 'diagram')
    const platform = (input.platform ?? 'desktop') as ImaginePlatform

    if (modules.length === 0) {
      return {
        data: {
          success: false,
          modules,
          platform,
          width: 0,
          text: '',
          message: 'modules must contain at least one module.',
        } satisfies Output,
      }
    }

    const text = renderImagineModules(modules, platform)
    const width = imaginePlatformWidth(platform)

    return {
      data: {
        success: true,
        modules,
        platform,
        width,
        text,
      } satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.text
        : `read_me failed: ${result.message ?? 'unknown error'}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
