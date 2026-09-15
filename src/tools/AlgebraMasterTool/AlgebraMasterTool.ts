import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  GUIDE,
  GUIDE_PATH,
  getReference,
  listReferences,
  type ReferenceAsset,
} from './assets.js'

const ALGEBRA_MASTER_TOOL_NAME = 'algebra-master'

const DESCRIPTION = `代数大师 (Algebra Master) —— 代数领域专家顾问。以群论/Galois、交换代数、李代数与根系、表示论、同调代数为主干，附带范畴论（普适性质/伴随/Yoneda）与代数几何/代数拓扑/K 理论接口。加载内置的人格指南与参考文档，给出代数问题的思考方式、常用策略与陷阱、知识地图与可计算结论（定理、公式、例子）。所有内容内置于工具目录，无外部依赖。触发词："群"、"环"、"域"、"理想"、"模"、"Galois"、"Sylow"、"特征标"、"表示"、"Lie 代数"、"根系"、"Dynkin"、"最高权"、"同调"、"上同调"、"导出函子"、"Tor"、"Ext"、"谱序列"、"范畴"、"伴随"、"Yoneda"、"普适性质"、"ideal"、"module"、"representation"、"root system"、"homology"、"adjunction"。`

const PERSONA_PROMPT = `
## 代数大师的工作方式 (每次作答前必读)

你是 DeepMind 自主研究集群里的「代数人格」。看到问题先问结构，而不是先算数字：

1. **先找对称性**：对象的全体自同构构成群；把问题翻译成群/环/模/根系。
2. **用同态与商刻画结构**："像 = 商掉核"（第一同构定理）是通用手术刀。
3. **拆成原子**：先证完全可约（Maschke / Weyl），再对不可约对象分类。
4. **有限情形用算术约束切**：Sylow 定理的 n_p ≡ 1 (mod p) 且 n_p | m 几乎能决定小阶群。
5. **搬到范畴里看普适性质**：凡满足同一万有性质的对象必同构；成对构造先找伴随。
6. **正合性被破坏就用同调测量缺陷**：Tor/Ext 量化函子的"错误"，谱序列逐页逼近。
7. **诚实**：不确定就说不确定，绝不编造定理或公式。

知识地图与完整方法论见 action=guide 返回的 SKILL.md；具体定理/公式/例子用 action=reference 取回对应文档。
`

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['guide', 'reference', 'list'])
      .describe(
        'guide: 返回代数大师的人格指南与方法论 (SKILL.md 正文). reference: 返回指定参考文档 (含定理/公式/例子). list: 列出所有可用参考文档.',
      ),
    reference: z
      .string()
      .optional()
      .describe(
        '参考文档名 (不含 .md 后缀), 如 group-theory-galois / commutative-algebra / lie-algebra-root-systems / representation-theory / homological-algebra / category-universal-properties / algebraic-geometry-topology-k. 仅当 action="reference" 时有效. 用 list 查看可选项.',
      )
      .meta({ eligibleActions: ['reference'] }),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('请求是否成功'),
    action: z.enum(['guide', 'reference', 'list']).describe('执行的 action'),
    summary: z.string().describe('本次操作的一行摘要'),
    content: z
      .string()
      .optional()
      .describe('请求的文档正文 (guide/reference 时返回)'),
    contentPath: z
      .string()
      .optional()
      .describe('资产在工具目录内的逻辑路径 (guide/reference 时返回)'),
    bytes: z
      .number()
      .int()
      .optional()
      .describe('返回内容的字节大小 (guide/reference 时返回)'),
    availableReferences: z
      .array(z.object({ name: z.string(), bytes: z.number() }))
      .optional()
      .describe('可用参考文档 (list 时返回)'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function refToSummary(r: ReferenceAsset): { name: string; bytes: number } {
  return { name: r.name, bytes: Buffer.byteLength(r.content, 'utf-8') }
}

function runGuide(): Output {
  return {
    success: true,
    action: 'guide',
    summary:
      'Loaded algebra-master persona guide (SKILL.md): persona, knowledge map, methodology, strategies and pitfalls.',
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

function runList(): Output {
  const refs = listReferences().map(refToSummary)
  return {
    success: true,
    action: 'list',
    summary: `algebra-master bundled assets: ${refs.length} references.`,
    availableReferences: refs,
  }
}

export const AlgebraMasterTool = buildTool({
  name: ALGEBRA_MASTER_TOOL_NAME,
  searchHint: 'algebra group ring field ideal module Galois Sylow character representation',
  maxResultSizeChars: 200_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION + PERSONA_PROMPT
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
    return 'AlgebraMaster'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.action}${input.reference ? ` ${input.reference}` : ''}`
  },
  async call(input: Input) {
    switch (input.action) {
      case 'reference':
        return { data: runReference(input.reference) }
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

    if (output.availableReferences && output.availableReferences.length > 0) {
      lines.push(
        `References: ${output.availableReferences.map(r => `${r.name}(${r.bytes}b)`).join(', ')}`,
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
