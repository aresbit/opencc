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

const ANALYSIS_MASTER_TOOL_NAME = 'analysis-master'

const DESCRIPTION = `分析大师 (Analysis Master) —— 数学分析领域的专家人格与知识地图。加载分析各分支的思考方式与可复用技术（复分析、测度与勒贝格积分、泛函分析、调和分析/Fourier、谱理论、几何分析/Sobolev、变分法、最优传输），并给出"先估计再精确 / ε-δ 量词审计 / 交换极限与积分要一致控制 / 用对偶与弱收敛抢救紧性 / 临界性与尺度不变性"等方法论。所有参考文档内置于工具目录，无外部依赖；内容为可用的数学定义、定理、证明思路与典型例。触发词："极限"、"收敛"、"连续"、"一致收敛"、"测度"、"勒贝格"、"可测"、"几乎处处"、"单调收敛"、"控制收敛"、"紧算子"、"Fredholm"、"Hahn-Banach"、"弱收敛"、"弱拓扑"、"Banach"、"Hilbert"、"谱"、"谱定理"、"谱测度"、"Sobolev"、"嵌入"、"调和函数"、"Harnack"、"Ricci"、"Fourier"、"卷积"、"Plancherel"、"好核"、"Fejer"、"奇异积分"、"插值"、"全纯"、"解析"、"Cauchy-Riemann"、"留数"、"共形映射"、"Mobius"、"黎曼映射"、"解析延拓"、"变分"、"Euler-Lagrange"、"Noether"、"守恒律"、"最优传输"、"Wasserstein"、"Kantorovich"、"Monge"、"Brenier"、"不等式估计"、"ML inequality"、"estimate"、"convergence"、"compact operator"、"holomorphic"、"measure"、"Lebesgue"、"Sobolev"、"Fourier"、"harmonic function"、"residue"、"conformal map"、"calculus of variations"、"optimal transport"、"duality"。"`

const METHODOLOGY_PROMPT = `
## 分析大师的思考习惯 (调用时默认启用)

1. **先做估计，再求精确**：看到积分/上确界/极限，先用 ML 不等式、Hölder、Minkowski、Cauchy–Schwarz、Young 把量级压住；恒等式往往是估计取等号的副产品。
2. **ε-δ 量词审计**：动手前先写下量词串，明确"哪个常数依赖哪个变量"，判断需要一致还是逐点。一致有界靠 Baire 纲定理（代价是完备性）。
3. **交换极限与积分要找一致控制**：有可积控制函数 → DCT；单调 → MCT；都没有 → 退守 Fatou 或弱收敛 + 凸性。没有一致控制不要交换。
4. **用对偶与弱收敛抢救紧性**：无限维里单位球不紧，改用弱\*紧（Banach–Alaoglu）/弱紧（Kakutani）取子列；需要强收敛时用 Mazur 凸组合。
5. **认临界性与尺度不变性**：尺度不变时紧性从根上失效（气泡化/集中），要去找临界阈值（如临界 Sobolev 指数 2* = 2n/(n-2)、Yamabe 阈值 Y(S^n)）而不是硬碰。

## 陷阱清单
- 交换极限与积分而不验证一致控制；
- 把逐点收敛当一致收敛（sup 与 lim 不可随意换）；
- 忘记完备性前提（三大原理、逆算子定理都要求 Banach 空间）;
- 把谱当成特征值集合（无限维里谱可连续，如乘法算子 x·f 谱 [0,1] 无特征值）;
- 忽略临界指数/尺度不变性（变分直接法在临界情形失效）;
- 把弱收敛当强收敛用（弱极限不保范数）;
- 解析延拓忘奇点（幂级数被最近奇点挡住）;
- 用 L^p 端点定理而不检查 p=1,∞（奇异积分在 L^1 只有弱型，L^∞ 落 BMO）。

详细指南: 调用 analysis-master action=guide 获取完整 SKILL.md（人格 + 知识地图 + 方法论）。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['guide', 'reference', 'list'])
      .describe(
        'guide: 返回主指南 (SKILL.md 正文，含人格/知识地图/方法论). reference: 返回指定参考文档. list: 列出所有可用参考文档.',
      ),
    reference: z
      .string()
      .optional()
      .describe(
        '参考文档名 (不含 .md 后缀). 仅当 action="reference" 时有效. 用 list 查看可选项.',
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
    summary: 'Loaded analysis-master main guide (SKILL.md).',
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
    summary: `analysis-master bundled assets: ${refs.length} references.`,
    availableReferences: refs,
  }
}

export const AnalysisMasterTool = buildTool({
  name: ANALYSIS_MASTER_TOOL_NAME,
  searchHint: 'mathematical analysis complex functional harmonic Sobolev Fourier measure',
  maxResultSizeChars: 200_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION + METHODOLOGY_PROMPT
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
    return 'AnalysisMaster'
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
