import { readFile } from 'fs/promises'
import { basename } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, PROTOCOL_RE_TOOL_NAME } from './prompt.js'
import {
  bytesToHex,
  clusterBySize,
  columnStats,
  hexToBytes,
  inferFsm,
} from './algorithms.js'
import type { ColumnStat, Cluster, Fsm } from './algorithms.js'
import type { Field, ProtocolSpec } from './spec.js'
import { specToJson, specToMarkdown } from './spec.js'
import { fileExists, readSpecFile, runCommand, writeSpecFile } from './runtime.js'

interface Workspace {
  id: string
  input: string
  messages: string[]
  fields: Field[]
  messageTypes: Cluster[]
  fsm: Fsm
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['extract', 'align', 'cluster', 'infer_fsm', 'report', 'export'])
      .describe('extract=normalize pcap/samples; align=field boundaries; cluster=message types; infer_fsm=state machine; report=read spec; export=render spec'),
    input: z
      .string()
      .optional()
      .describe('pcap path or message-sample file (hex/ascii, one message per line). Required for extract; report/export can reuse the last workspace.'),
    format: z
      .enum(['pcap', 'hex', 'ascii'])
      .optional()
      .default('pcap')
      .describe('How to interpret input during extract.'),
    filter: z
      .string()
      .optional()
      .describe('tshark display filter for pcap (e.g. tcp.port==4444).'),
    maxMessages: z.number().int().positive().optional().default(200).describe('Sample cap for extract.'),
    minSupport: z.number().int().positive().optional().default(2).describe('infer_fsm min transition count.'),
    exportFormat: z.enum(['markdown', 'json']).optional().default('markdown').describe('export render format.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    message: z.string(),
    specId: z.string().optional(),
    messageCount: z.number().optional(),
    messages: z.array(z.string()).optional(),
    alignment: z
      .array(z.object({ offset: z.number(), constantRate: z.number(), entropy: z.number(), dominantByte: z.number() }))
      .optional(),
    clusters: z
      .array(z.object({ id: z.number(), size: z.number(), count: z.number(), sampleHex: z.string() }))
      .optional(),
    fsm: z
      .object({
        states: z.array(z.object({ id: z.number(), cluster: z.number(), count: z.number() })),
        transitions: z.array(z.object({ from: z.number(), to: z.number(), count: z.number() })),
      })
      .optional(),
    spec: z.any().optional(),
    exportedPath: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (!input.action) return null
  return input.input ? `protocolre ${input.action} ${input.input}` : `protocolre ${input.action}`
}

function specIdFor(input: string): string {
  const base = basename(input).replace(/[^a-zA-Z0-9._-]/g, '_') || 'session'
  return base.replace(/\.(pcap|pcapng|txt|hex)$/i, '') || 'session'
}

function defaultWorkspace(id: string, input: string): Workspace {
  return { id, input, messages: [], fields: [], messageTypes: [], fsm: { states: [], transitions: [] } }
}

function fieldKindFromColumn(col: ColumnStat): Field['kind'] {
  if (col.constantRate >= 0.9) return 'const'
  if (col.entropy >= 6.5) return 'unknown' // high entropy: checksum/timestamp/random — leave to agent
  return 'var'
}

export const ProtocolReTool = buildTool({
  name: PROTOCOL_RE_TOOL_NAME,
  searchHint:
    'reverse engineer a network protocol format and state machine from pcap or message samples',
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
    return 'ProtocolReTool'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.input
      ? `protocolre ${input.action} ${input.input}`
      : `protocolre ${input.action}`
  },
  renderToolUseMessage,
  async call(input, context) {
    const signal = context.abortController.signal
    switch (input.action) {
      case 'extract':
        return runExtract(input, signal)
      case 'align':
        return runAlign(input)
      case 'cluster':
        return runCluster(input)
      case 'infer_fsm':
        return runInferFsm(input)
      case 'report':
        return runReport(input)
      case 'export':
        return runExport(input)
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `protocolre ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runExtract(input: Input, signal: AbortSignal): Promise<{ data: Output }> {
  if (!input.input) {
    return failure('extract', 'input (pcap path or sample file) is required for action "extract".')
  }
  const id = specIdFor(input.input)
  try {
    let messages: string[] = []
    if (input.format === 'pcap') {
      const filterArg = input.filter ? input.filter : 'tcp or udp'
      const result = await runCommand(
        ['tshark', '-r', input.input, '-Y', filterArg, '-T', 'fields', '-e', 'data'],
        { signal, timeoutMs: 120_000 },
      )
      if (result.exitCode !== 0) {
        return failure(
          'extract',
          `tshark failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}. If tshark is missing, install it, or pass a hex/ascii sample file with format.`,
        )
      }
      messages = result.stdout
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => l.replace(/[:,]/g, ''))
    } else {
      const text = await readFile(input.input, { encoding: 'utf-8' })
      messages = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map(l => (input.format === 'ascii' ? Buffer.from(l, 'utf-8').toString('hex') : l))
    }

    if (messages.length === 0) {
      return failure('extract', 'no messages extracted.')
    }
    // Dedup + sample.
    const uniq = [...new Set(messages)].slice(0, input.maxMessages ?? 200)
    const ws = defaultWorkspace(id, input.input)
    ws.messages = uniq
    await writeSpecFile(id, ws)

    return {
      data: {
        success: true,
        action: 'extract',
        message: `Extracted ${uniq.length} unique messages (deduped, capped at ${input.maxMessages}) into workspace "${id}". Next: action "align".`,
        specId: id,
        messageCount: uniq.length,
        messages: uniq.slice(0, 20),
      },
    }
  } catch (error) {
    return failure('extract', error instanceof Error ? error.message : String(error))
  }
}

async function loadWorkspace(input: Input): Promise<Workspace | { data: Output }> {
  if (!input.input) return failure(input.action, `input is required to locate the workspace.`)
  const id = specIdFor(input.input)
  const ws = await readSpecFile<Workspace>(id)
  if (!ws) return failure(input.action, `no workspace "${id}". Run action "extract" first.`)
  return ws
}

async function runAlign(input: Input): Promise<{ data: Output }> {
  const ws = await loadWorkspace(input)
  if ('data' in ws) return ws
  if (ws.messages.length === 0) return failure('align', 'workspace has no messages; run "extract" first.')
  const rows = ws.messages.map(m => hexToBytes(m))
  const stats = columnStats(rows)
  ws.fields = stats.map(col => ({
    offset: col.offset,
    width: 1,
    kind: fieldKindFromColumn(col),
    confidence: col.constantRate >= 0.9 || col.entropy >= 6.5 ? 'high' : 'medium',
  }))
  await writeSpecFile(ws.id, ws)

  const lines = stats.map(col => {
    const byte = col.dominantByte < 0 ? '--' : col.dominantByte.toString(16).padStart(2, '0')
    const label = col.constantRate >= 0.9 ? 'const' : col.entropy >= 6.5 ? 'high-entropy' : 'var'
    return `offset ${col.offset.toString().padStart(3)}: 0x${byte}  const=${col.constantRate.toFixed(2)}  entropy=${col.entropy.toFixed(2)}  [${label}]`
  })

  return {
    data: {
      success: true,
      action: 'align',
      message:
        `Column stats over ${rows.length} messages (positional alignment):\n` +
        lines.join('\n') +
        '\n\nRead this table to infer field semantics (length/checksum/enum), then annotate the spec.',
      specId: ws.id,
      alignment: stats,
    },
  }
}

async function runCluster(input: Input): Promise<{ data: Output }> {
  const ws = await loadWorkspace(input)
  if ('data' in ws) return ws
  if (ws.messages.length === 0) return failure('cluster', 'workspace has no messages; run "extract" first.')
  const rows = ws.messages.map(m => hexToBytes(m))
  const clusters = clusterBySize(rows)
  ws.messageTypes = clusters
  await writeSpecFile(ws.id, ws)
  return {
    data: {
      success: true,
      action: 'cluster',
      message:
        `${clusters.length} message type(s) by length:\n` +
        clusters.map(c => `- type ${c.id}: size ${c.size}B, ${c.count} msg, sample ${c.sampleHex.slice(0, 32)}...`).join('\n'),
      specId: ws.id,
      clusters,
    },
  }
}

async function runInferFsm(input: Input): Promise<{ data: Output }> {
  const ws = await loadWorkspace(input)
  if ('data' in ws) return ws
  if (ws.messages.length === 0) return failure('infer_fsm', 'workspace has no messages; run "extract" first.')
  // Type label = cluster by length (recompute if not clustered yet).
  const rows = ws.messages.map(m => hexToBytes(m))
  const clusters = clusterBySize(rows)
  const sizeToType = new Map<number, number>()
  clusters.forEach(c => sizeToType.set(c.size, c.id))
  const labels = rows.map(r => sizeToType.get(r.length) ?? -1)
  const fsm = inferFsm(labels, input.minSupport ?? 2)
  ws.messageTypes = clusters
  ws.fsm = fsm
  await writeSpecFile(ws.id, ws)
  return {
    data: {
      success: true,
      action: 'infer_fsm',
      message:
        `Coarse FSM (minSupport=${input.minSupport}):\n` +
        (fsm.transitions.length
          ? fsm.transitions.map(t => `- type ${t.from} -> type ${t.to}: ${t.count}`).join('\n')
          : '(no transitions above threshold)'),
      specId: ws.id,
      fsm,
    },
  }
}

async function runReport(input: Input): Promise<{ data: Output }> {
  const ws = await loadWorkspace(input)
  if ('data' in ws) return ws
  const spec: ProtocolSpec = {
    id: ws.id,
    input: ws.input,
    fields: ws.fields,
    messageTypes: ws.messageTypes,
    fsm: ws.fsm,
  }
  return {
    data: {
      success: true,
      action: 'report',
      message: specToMarkdown(spec),
      specId: ws.id,
      spec,
    },
  }
}

async function runExport(input: Input): Promise<{ data: Output }> {
  const ws = await loadWorkspace(input)
  if ('data' in ws) return ws
  const spec: ProtocolSpec = {
    id: ws.id,
    input: ws.input,
    fields: ws.fields,
    messageTypes: ws.messageTypes,
    fsm: ws.fsm,
    exportedAt: new Date().toISOString(),
  }
  const fmt = input.exportFormat ?? 'markdown'
  const ext = fmt === 'json' ? 'json' : 'md'
  const content = fmt === 'json' ? specToJson(spec) : specToMarkdown(spec)
  // Write alongside the spec file.
  const { stateDir } = await import('./runtime.js')
  const dir = stateDir()
  const outPath = `${dir}/${spec.id}.spec.${ext}`
  await Bun.write(outPath, content)
  return {
    data: {
      success: true,
      action: 'export',
      message: `Exported ${fmt} to ${outPath}`,
      specId: ws.id,
      spec,
      exportedPath: outPath,
    },
  }
}
