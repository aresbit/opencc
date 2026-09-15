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

const COMBINATORICS_MASTER_TOOL_NAME = 'combinatorics-master'

const DESCRIPTION = `组合数学领域专家顾问（组合大师）。加载内置的离散数学知识库：计数与生成函数、图的结构与匹配、Ramsey 理论与概率方法、极值图论、Szemerédi 正则引理/伪随机/图极限、谱方法、加性组合（Roth/Freiman/和积）。所有内容内置于工具目录，无外部依赖。返回指定参考文档正文，模型据此给出定义、定理、证明思路、构造与陷阱提示。触发词："计数"、"排列组合"、"生成函数"、"容斥"、"鸽巢"、"双计数"、"匹配"、"流"、"染色"、"Ramsey"、"极值图论"、"Turán"、"Erdős"、"概率方法"、"正则引理"、"伪随机"、"谱图论"、"特征值"、"等差数列"、"Freiman"、"和积"、"组合数学"、"counting"、"combinatorics"、"generating function"、"inclusion-exclusion"、"pigeonhole"、"matching"、"coloring"、"extremal graph"、"probabilistic method"、"regularity lemma"、"spectral graph"、"additive combinatorics"。`

const PERSONA_PROMPT = `
## 组合大师人格 (每次作答前内化)

你是一个组合学家。面对"一个足够大的离散结构何时必然包含某子结构"这类问题时：

- **先分类**：这是极值问题（禁止子图/定极值数）、存在性问题（有没有某构型）、计数问题（有多少个），还是结构问题（小加倍常数蕴含什么结构）？四类问题工具箱不同。
- **先猜极值构造，再证界**：完全多部图（Turán）、极性图、随机构造、代数（范数）构造——界贴着构造走。
- **需要存在性时不构造，只证明随机对象大概率是好的**（概率方法）。
- **一切"至少/至多/或"背后有一个计数器**：握手引理、双计数、容斥、过计数纠正、期望线性性。
- **"足够大"意味着二分**：要么伪随机（正则/谱工具统计子结构），要么有结构（密度增量降维递归）。
- **对偶**：路径数=割数（Menger/最大流最小割），匹配=顶点覆盖（Kőnig），平面图圈↔割。

常见陷阱：极大≠最大；两两独立弱于相互独立；色数不是局部量；正则引理的常数是塔函数量级；Fourier 系数小只控制 3-AP 不控制 4-AP；算"或"时别忘减交。

详细人格、知识地图与方法论（双计数/生成函数/概率方法/极值构造/对偶）：调用 combinatorics-master action=guide 获取完整 SKILL.md。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['guide', 'reference', 'list'])
      .describe(
        'guide: 返回组合大师主指南 (SKILL.md 正文，含人格/知识地图/方法论). reference: 返回指定参考文档. list: 列出所有可用参考文档.',
      ),
    reference: z
      .string()
      .optional()
      .describe('参考文档名 (不含 .md 后缀). 仅当 action="reference" 时有效. 用 list 查看可选项.')
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
    summary: 'Loaded combinatorics-master main guide (SKILL.md).',
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
    summary: `combinatorics-master bundled assets: ${refs.length} references.`,
    availableReferences: refs,
  }
}

export const CombinatoricsMasterTool = buildTool({
  name: COMBINATORICS_MASTER_TOOL_NAME,
  searchHint: 'combinatorics counting generating functions extremal graph ramsey matching coloring spectral additive',
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
    return 'CombinatoricsMaster'
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
