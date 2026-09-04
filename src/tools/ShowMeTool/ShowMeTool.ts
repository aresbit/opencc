import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, SHOW_ME_TOOL_NAME } from './prompt.js'
import {
  formatDiff,
  formatPseudocode,
  formatTable,
  formatTree,
  writeArtifact,
} from './render.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['diagram', 'tree', 'diff', 'table', 'pseudocode', 'html'])
      .optional()
      .default('diagram')
      .describe('diagram=mermaid; tree=file/component/call tree; diff=before/after; table=comparison; pseudocode=algorithm; html=custom artifact'),
    spec: z
      .string()
      .optional()
      .describe('The content to render. For diagram: Mermaid source. For tree: indented text. For pseudocode: algorithm text. For html: HTML content.'),
    title: z
      .string()
      .optional()
      .describe('Title for the visual.'),
    before: z
      .string()
      .optional()
      .describe('For diff: the "before" content.'),
    after: z
      .string()
      .optional()
      .describe('For diff: the "after" content.'),
    headers: z
      .array(z.string())
      .optional()
      .describe('For table: column headers.'),
    rows: z
      .array(z.array(z.string()))
      .optional()
      .describe('For table: data rows (array of arrays).'),
    diagramType: z
      .enum(['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'pie', 'mindmap', 'timeline', 'graph'])
      .optional()
      .describe('For diagram: Mermaid diagram type hint (auto-detected from spec if omitted).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    message: z.string(),
    format: z.string().optional(),
    content: z.string().optional(),
    artifactPath: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  const action = input.action ?? 'diagram'
  return input.title ? `showme ${action} "${input.title}"` : `showme ${action}`
}

export const ShowMeTool = buildTool({
  name: SHOW_ME_TOOL_NAME,
  searchHint:
    'explain a concept visually — diagram, tree, diff, table, pseudocode, or HTML artifact',
  maxResultSizeChars: 50_000,
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
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ShowMeTool'
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
    const action = input.action ?? 'diagram'
    return input.title ? `showme ${action} ${input.title}` : `showme ${action}`
  },
  renderToolUseMessage,
  async call(input, _context) {
    const action = input.action ?? 'diagram'
    switch (action) {
      case 'diagram':
        return runDiagram(input)
      case 'tree':
        return runTree(input)
      case 'diff':
        return runDiff(input)
      case 'table':
        return runTable(input)
      case 'pseudocode':
        return runPseudocode(input)
      case 'html':
        return runHtml(input)
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `showme ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function runDiagram(input: Input): { data: Output } {
  if (!input.spec) return failure('diagram', 'spec (Mermaid source) is required for action "diagram".')
  const spec = input.spec.trim()
  const title = input.title ? `## ${input.title}\n\n` : ''
  const content = `${title}\`\`\`mermaid\n${spec}\n\`\`\``
  return {
    data: {
      success: true,
      action: 'diagram',
      message: content,
      format: 'mermaid',
      content: spec,
    },
  }
}

function runTree(input: Input): { data: Output } {
  if (!input.spec) return failure('tree', 'spec (indented text) is required for action "tree".')
  const tree = formatTree(input.spec)
  const title = input.title ? `## ${input.title}\n\n` : ''
  const content = `${title}\`\`\`\n${tree}\n\`\`\``
  return {
    data: {
      success: true,
      action: 'tree',
      message: content,
      format: 'tree',
      content: tree,
    },
  }
}

function runDiff(input: Input): { data: Output } {
  if (!input.before || !input.after) {
    return failure('diff', 'before and after are required for action "diff".')
  }
  const diff = formatDiff(input.before, input.after)
  const title = input.title ? `## ${input.title}\n\n` : ''
  const content = `${title}\`\`\`diff\n${diff}\n\`\`\``
  return {
    data: {
      success: true,
      action: 'diff',
      message: content,
      format: 'diff',
      content: diff,
    },
  }
}

function runTable(input: Input): { data: Output } {
  if (!input.headers || !input.rows) {
    return failure('table', 'headers and rows are required for action "table".')
  }
  const table = formatTable(input.headers, input.rows)
  const title = input.title ? `## ${input.title}\n\n` : ''
  const content = `${title}${table}`
  return {
    data: {
      success: true,
      action: 'table',
      message: content,
      format: 'markdown-table',
      content: table,
    },
  }
}

function runPseudocode(input: Input): { data: Output } {
  if (!input.spec) return failure('pseudocode', 'spec (algorithm text) is required for action "pseudocode".')
  const code = formatPseudocode(input.spec)
  const title = input.title ? `## ${input.title}\n\n` : ''
  const content = `${title}${code}`
  return {
    data: {
      success: true,
      action: 'pseudocode',
      message: content,
      format: 'pseudocode',
      content: input.spec.trim(),
    },
  }
}

async function runHtml(input: Input): Promise<{ data: Output }> {
  if (!input.spec) return failure('html', 'spec (HTML content) is required for action "html".')
  try {
    const name = (input.title ?? 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_') + '.html'
    const path = await writeArtifact(name, input.spec)
    return {
      data: {
        success: true,
        action: 'html',
        message: `HTML artifact written to ${path}`,
        format: 'html',
        content: input.spec,
        artifactPath: path,
      },
    }
  } catch (error) {
    return failure('html', error instanceof Error ? error.message : String(error))
  }
}
