import { accessSync, existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { openPath } from '../../utils/browser.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  formatWarning,
  LintError,
  ParseError,
  renderPage,
  RenderError,
  type RenderOverrides,
} from './page/index.js'
import { DESCRIPTION, getPrompt, SHOW_ME_TOOL_NAME } from './prompt.js'
import {
  formatDiff,
  formatPseudocode,
  formatTable,
  formatTree,
  writeArtifact,
} from './render.js'
import { renderToolResultMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['diagram', 'tree', 'diff', 'table', 'pseudocode', 'html', 'page'])
      .optional()
      .default('diagram')
      .describe('diagram=mermaid; tree=file/component/call tree; diff=before/after; table=comparison; pseudocode=algorithm; html=custom artifact; page=content draft rendered to an HTML page'),
    spec: z
      .string()
      .optional()
      .describe('The content to render. For diagram: Mermaid source. For tree: indented text. For pseudocode: algorithm text. For html: HTML content. For page: the content draft (frontmatter + "## " panels).'),
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
    theme: z
      .enum(['blueprint', 'shadcn'])
      .optional()
      .describe('For page: color theme.'),
    template: z
      .enum(['sheet', 'doc'])
      .optional()
      .describe('For page: layout template.'),
    mode: z
      .enum(['auto', 'light', 'dark'])
      .optional()
      .describe('For page: light/dark mode.'),
    style: z
      .enum(['off', '80', 'strict'])
      .optional()
      .describe('For page: STE writing-check strictness (off=skip, 80=warn, strict=refuse on any warning).'),
    open: z
      .boolean()
      .optional()
      .describe('For page: open the rendered page in a browser (default true).'),
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
    warnings: z.array(z.string()).optional(),
    diagnostic: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  const action = input.action ?? 'diagram'
  if (action === 'page') {
    const label = (input.title?.trim() || input.spec?.trim() || '')
      .split('\n')[0]
      .trim()
      .slice(0, 80)
    return label ? `showme page "${label}"` : 'showme page'
  }
  return input.title ? `showme ${action} "${input.title}"` : `showme ${action}`
}

export const ShowMeTool = buildTool({
  name: SHOW_ME_TOOL_NAME,
  searchHint:
    'explain a concept visually — diagram, tree, diff, table, pseudocode, page, or HTML artifact',
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
  renderToolResultMessage,
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
      case 'page':
        return runPage(input)
      default:
        return failure(action, `Unknown action "${action}".`)
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

function slugify(text: string): string {
  return (
    text
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'page'
  )
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// On Termux/Bun, spawning a bare command name that is a shell script fails
// ("sh: cannot open termux-open"). Resolve to an absolute executable path.
function resolveExecutable(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name)
      try {
        accessSync(candidate, 1 /* X_OK */)
        return candidate
      } catch {
        // not executable here; keep looking
      }
    }
  }
  return null
}

async function openInBrowser(path: string): Promise<boolean> {
  try {
    if (await openPath(path)) return true
    for (const name of ['termux-open', 'xdg-open']) {
      const bin = resolveExecutable([name])
      if (!bin) continue
      if ((await execFileNoThrow(bin, [path])).code === 0) return true
    }
  } catch {
    // never turn a successful render into a failed tool call
  }
  return false
}

function uniquePath(dir: string, name: string): string {
  const ext = '.html'
  const stem = name.endsWith(ext) ? name.slice(0, -ext.length) : name
  let candidate = join(dir, name)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${n}${ext}`)
    n++
  }
  return candidate
}

async function runPage(input: Input): Promise<{ data: Output }> {
  if (!input.spec) {
    return failure('page', 'spec (the content draft) is required for action "page".')
  }

  const overrides: RenderOverrides = {}
  if (input.theme) overrides.theme = input.theme
  if (input.template) overrides.template = input.template
  if (input.mode) overrides.mode = input.mode
  if (input.style) overrides.style = input.style

  try {
    const { html, warnings, meta } = renderPage(input.spec, overrides)

    const name = `${slugify(input.title || meta.title || 'page')}-${timestamp()}.html`
    const dir = join(getClaudeConfigHomeDir(), 'showme', 'pages')
    await mkdir(dir, { recursive: true })
    const path = uniquePath(dir, name)
    await Bun.write(path, html)

    const opened = input.open !== false ? await openInBrowser(path) : false

    const formatted = warnings.map(formatWarning)
    const lines = [`page rendered: ${path}`]
    if (formatted.length) {
      lines.push(`STE ${formatted.length} 条警告`)
      lines.push(...formatted.slice(0, 20))
      if (formatted.length > 20) {
        lines.push(`... 还有 ${formatted.length - 20} 条`)
      }
    }
    if (input.open !== false) {
      lines.push(opened ? 'opened in browser' : 'could not open a browser; open the path manually')
    }

    return {
      data: {
        success: true,
        action: 'page',
        message: lines.join('\n'),
        format: 'html',
        content: path,
        artifactPath: path,
        warnings: formatted.length ? formatted : undefined,
      },
    }
  } catch (error) {
    if (error instanceof RenderError) {
      const diagnostic = `L${error.line} [${error.component}] ${error.message}\n正确示例：\n    ${error.example}\n完整语法：am help ${error.component}`
      return { data: { success: false, action: 'page', message: diagnostic, diagnostic } }
    }
    if (error instanceof ParseError) {
      const diagnostic = `[L${error.line}] 稿件解析失败：${error.message}`
      return { data: { success: false, action: 'page', message: diagnostic, diagnostic } }
    }
    if (error instanceof LintError) {
      const diagnostic = error.warnings.map(formatWarning).join('\n')
      return {
        data: {
          success: false,
          action: 'page',
          message: `STE 检查未通过（style: strict）：\n${diagnostic}`,
          diagnostic,
        },
      }
    }
    return failure('page', error instanceof Error ? error.message : String(error))
  }
}
