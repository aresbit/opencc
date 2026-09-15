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

const NUMBER_THEORY_MASTER_TOOL_NAME = 'number-theory-master'

const DESCRIPTION = `数论大师（Number Theory Master）——以数论领域专家人格回答计算数论、代数数论与解析数论问题。知识内容全部内置于工具目录，无外部依赖。覆盖：素数分布与素性检验（试除/Miller–Rabin/AKS）、同余与中国剩余定理、模逆元与 RSA、二次剩余与二次互反律（Legendre/Jacobi、Tonelli–Shanks）、离散对数与整数分解（本原根、baby-step giant-step、Diffie–Hellman、光滑数、index calculus、Dixon、数域筛）、有限域与有限域算法（Frobenius、Cantor–Zassenhaus、Berlekamp）、代数数论（数域与整数环、戴德金环、理想唯一分解、素理想分解 e/f/g 与 Kummer 定理、Minkowski 界、理想类群、Dirichlet 单位定理）、解析数论（Riemann zeta 与 Euler 乘积、Dirichlet 特征与 L 函数、Dirichlet 定理、素数定理与 Newman 解析定理、黎曼假设、函数方程）。触发词："素数"、"素性检验"、"Miller-Rabin"、"AKS"、"同余"、"中国剩余定理"、"模逆元"、"二次剩余"、"二次互反律"、"Legendre 符号"、"Jacobi 符号"、"离散对数"、"整数分解"、"RSA"、"Diffie-Hellman"、"原根"、"有限域"、"Galois 域"、"Frobenius"、"理想类群"、"戴德金环"、"素理想分解"、"数域"、"Dirichlet 定理"、"Dirichlet 特征"、"Riemann zeta"、"L 函数"、"素数定理"、"Chebyshev"、"Möbius"、"黎曼假设"、"模运算"、"Euclid 算法"、"Bézout"；英文："prime"、"primality test"、"congruence"、"CRT"、"quadratic residue"、"quadratic reciprocity"、"discrete logarithm"、"integer factorization"、"finite field"、"primitive root"、"ideal class group"、"Dedekind domain"、"number field"、"Dirichlet"、"Riemann zeta"、"L-function"、"prime number theorem"、"analytic number theory"、"algebraic number theory"。覆盖边界：不含模形式/自守表示与 p-adic 分析（p-adic 只从局部化/DVR/赋值这一代数影子作答），不含椭圆曲线算术（仅作为离散对数依赖的替代群提及）。`

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['guide', 'reference', 'list'])
      .describe(
        'guide: 返回数论大师主指南 (SKILL.md 正文，含人格、知识地图与方法论). reference: 返回指定参考文档的完整数学内容. list: 列出全部可用参考文档及其字节数.',
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
    summary: 'Loaded number-theory-master main guide (SKILL.md).',
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
    summary: `number-theory-master bundled assets: ${refs.length} references.`,
    availableReferences: refs,
  }
}

export const NumberTheoryMasterTool = buildTool({
  name: NUMBER_THEORY_MASTER_TOOL_NAME,
  searchHint: 'number theory primes congruence quadratic residue finite field ideal class group zeta',
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
    return 'NumberTheoryMaster'
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
