import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  GUIDE,
  GUIDE_PATH,
  getReference,
  getScript,
  listReferences,
  listScripts,
  type ReferenceAsset,
  type ScriptAsset,
} from './assets.js'

const AWR_OPS_TOOL_NAME = 'awr-ops'

const DESCRIPTION = `Thor 开发板应用包和固件部署操作知识工具。加载 AWR 部署运维文档（板载编译、.run 大包部署、thor 镜像烧录、A/B slot 切换恢复、rsync/三跳中继传输、eHMI 远程控制、Gate-1 E2E 验证）与 eHMI 客户端脚本。所有内容内置于工具目录，无外部依赖。返回文档正文与脚本源码，模型可用 BashTool/FileWriteTool 实际执行命令。触发词："部署到 thor"、"刷大包"、"刷镜像"、"deploy to thor"、"awr deploy"、"烧录固件"、"rsync 传输"、"锁精定位"、"ehmi"、"HMI 控制"、"recipe 创建"、"gate1"。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['guide', 'reference', 'script', 'list'])
      .describe(
        'guide: 返回主部署运维指南 (SKILL.md 正文). reference: 返回指定参考文档. script: 返回指定脚本源码 (模型可写入临时文件后用 BashTool 执行). list: 列出所有可用参考文档与脚本.',
      ),
    reference: z
      .string()
      .optional()
      .describe('参考文档名 (不含 .md 后缀). 仅当 action="reference" 时有效. 用 list 查看可选项.')
      .meta({ eligibleActions: ['reference'] }),
    script: z
      .string()
      .optional()
      .describe('脚本名. 仅当 action="script" 时有效. 用 list 查看可选项.')
      .meta({ eligibleActions: ['script'] }),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('请求是否成功'),
    action: z
      .enum(['guide', 'reference', 'script', 'list'])
      .describe('执行的 action'),
    summary: z.string().describe('本次操作的一行摘要'),
    content: z
      .string()
      .optional()
      .describe('请求的文档/脚本正文 (guide/reference/script 时返回)'),
    contentPath: z
      .string()
      .optional()
      .describe('资产在工具目录内的逻辑路径 (guide/reference/script 时返回)'),
    bytes: z
      .number()
      .int()
      .optional()
      .describe('返回内容的字节大小 (guide/reference/script 时返回)'),
    language: z
      .enum(['python', 'bash', 'text'])
      .optional()
      .describe('脚本语言 (script 时返回)'),
    suggestedFilename: z
      .string()
      .optional()
      .describe('建议的临时文件名 (script 时返回，便于模型用 FileWriteTool 落盘执行)'),
    availableReferences: z
      .array(z.object({ name: z.string(), bytes: z.number() }))
      .optional()
      .describe('可用参考文档 (list 时返回)'),
    availableScripts: z
      .array(
        z.object({
          name: z.string(),
          language: z.enum(['python', 'bash', 'text']),
          suggestedFilename: z.string(),
          bytes: z.number(),
        }),
      )
      .optional()
      .describe('可用脚本 (list 时返回)'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function refToSummary(r: ReferenceAsset): { name: string; bytes: number } {
  return { name: r.name, bytes: Buffer.byteLength(r.content, 'utf-8') }
}

function scriptToSummary(s: ScriptAsset): {
  name: string
  language: 'python' | 'bash' | 'text'
  suggestedFilename: string
  bytes: number
} {
  return {
    name: s.name,
    language: s.language,
    suggestedFilename: s.suggestedFilename,
    bytes: Buffer.byteLength(s.content, 'utf-8'),
  }
}

function runGuide(): Output {
  return {
    success: true,
    action: 'guide',
    summary: 'Loaded awr-ops main deployment guide (SKILL.md).',
    content: GUIDE,
    contentPath: GUIDE_PATH,
    bytes: Buffer.byteLength(GUIDE, 'utf-8'),
  }
}

function runReference(reference: string | undefined): Output {
  if (!reference || !reference.trim()) {
    return {
      success: false,
      action: 'reference',
      summary: `action="reference" requires the "reference" parameter. Available: ${listReferences()
        .map(r => r.name)
        .join(', ')}.`,
      availableReferences: listReferences().map(refToSummary),
    }
  }
  const ref = getReference(reference)
  if (!ref) {
    return {
      success: false,
      action: 'reference',
      summary: `Unknown reference "${reference}". Available: ${listReferences()
        .map(r => r.name)
        .join(', ')}.`,
      availableReferences: listReferences().map(refToSummary),
    }
  }
  return {
    success: true,
    action: 'reference',
    summary: `Loaded reference "${ref.name}".`,
    content: ref.content,
    contentPath: ref.path,
    bytes: Buffer.byteLength(ref.content, 'utf-8'),
  }
}

function runScript(script: string | undefined): Output {
  if (!script || !script.trim()) {
    return {
      success: false,
      action: 'script',
      summary: `action="script" requires the "script" parameter. Available: ${listScripts()
        .map(s => s.name)
        .join(', ')}.`,
      availableScripts: listScripts().map(scriptToSummary),
    }
  }
  const s = getScript(script)
  if (!s) {
    return {
      success: false,
      action: 'script',
      summary: `Unknown script "${script}". Available: ${listScripts()
        .map(x => x.name)
        .join(', ')}.`,
      availableScripts: listScripts().map(scriptToSummary),
    }
  }
  return {
    success: true,
    action: 'script',
    summary: `Loaded script "${s.name}" (${s.language}). Write to a temp file (e.g. /tmp/${s.suggestedFilename}) and run via BashTool.`,
    content: s.content,
    contentPath: s.path,
    bytes: Buffer.byteLength(s.content, 'utf-8'),
    language: s.language,
    suggestedFilename: s.suggestedFilename,
  }
}

function runList(): Output {
  const refs = listReferences().map(refToSummary)
  const scripts = listScripts().map(scriptToSummary)
  return {
    success: true,
    action: 'list',
    summary: `awr-ops bundled assets: ${refs.length} references, ${scripts.length} scripts.`,
    availableReferences: refs,
    availableScripts: scripts,
  }
}

export const AwrOpsTool = buildTool({
  name: AWR_OPS_TOOL_NAME,
  searchHint: 'thor board deployment flashing rsync ehmi',
  maxResultSizeChars: 200_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
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
    return 'AwrOps'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.action}${input.reference ? ` ${input.reference}` : ''}${input.script ? ` ${input.script}` : ''}`
  },
  async call(input: Input) {
    switch (input.action) {
      case 'reference':
        return { data: runReference(input.reference) }
      case 'script':
        return { data: runScript(input.script) }
      case 'list':
        return { data: runList() }
      case 'guide':
      default:
        return { data: runGuide() }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [output.summary]

    if (output.contentPath) {
      const sizeInfo = output.bytes ? ` (${output.bytes} bytes)` : ''
      lines.push(`Source: ${output.contentPath}${sizeInfo}`)
    }

    if (output.suggestedFilename) {
      lines.push(`Suggested temp file: /tmp/${output.suggestedFilename}`)
    }

    if (output.availableReferences && output.availableReferences.length > 0) {
      lines.push(
        `References: ${output.availableReferences.map(r => `${r.name}(${r.bytes}b)`).join(', ')}`,
      )
    }

    if (output.availableScripts && output.availableScripts.length > 0) {
      lines.push(
        `Scripts: ${output.availableScripts
          .map(s => `${s.name}[${s.language}](${s.bytes}b)`)
          .join(', ')}`,
      )
    }

    // Keep the in-transcript preview short — the full content is in the tool
    // result payload. A 200-char preview is enough for the human to see what
    // was returned without flooding the terminal.
    if (output.content) {
      const preview = output.content.slice(0, 200)
      const ellipsis = output.content.length > 200 ? '…' : ''
      lines.push(`Preview:\n${preview}${ellipsis}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
