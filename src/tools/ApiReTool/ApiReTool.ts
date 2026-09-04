import { readFile } from 'fs/promises'
import { basename } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { API_RE_TOOL_NAME, DESCRIPTION, getPrompt } from './prompt.js'
import {
  clusterEndpoints,
  endpointsToMarkdown,
  parseHar,
  type Endpoint,
  type Request,
} from './har.js'
import { buildBrief, SUPPORTED_LANGUAGES, type Language } from './codegen.js'
import { readWorkspaceFile, writeWorkspaceFile, workspaceDir } from './runtime.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['capture', 'infer', 'export', 'generate_client', 'report'])
      .describe('capture=read HAR; infer=cluster endpoints; export=render; generate_client=brief; report=read workspace'),
    source: z.enum(['har']).optional().default('har').describe('Traffic source. MVP: "har".'),
    harPath: z.string().optional().describe('HAR file path (capture).'),
    filter: z.string().optional().describe('Only keep requests whose URL contains this substring.'),
    maxEntries: z.number().int().positive().optional().default(200).describe('Sample cap for capture.'),
    language: z.enum(SUPPORTED_LANGUAGES).optional().default('python').describe('generate_client target language.'),
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
    workspaceId: z.string().optional(),
    requestCount: z.number().optional(),
    requests: z.array(z.any()).optional(),
    endpoints: z.array(z.any()).optional(),
    brief: z.string().optional(),
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
  return input.harPath ? `apire ${input.action} ${input.harPath}` : `apire ${input.action}`
}

function workspaceIdFor(harPath: string): string {
  return basename(harPath).replace(/\.[a-z]+$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'session'
}

export const ApiReTool = buildTool({
  name: API_RE_TOOL_NAME,
  searchHint:
    'reverse engineer a website HTTP API from captured traffic (HAR) into endpoints and a typed client',
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
    return 'ApiReTool'
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
    return input.harPath
      ? `apire ${input.action} ${input.harPath}`
      : `apire ${input.action}`
  },
  renderToolUseMessage,
  async call(input, _context) {
    switch (input.action) {
      case 'capture':
        return runCapture(input)
      case 'infer':
        return runInfer(input)
      case 'export':
        return runExport(input)
      case 'generate_client':
        return runGenerateClient(input)
      case 'report':
        return runReport(input)
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `apire ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runCapture(input: Input): Promise<{ data: Output }> {
  if (!input.harPath) {
    return failure('capture', 'harPath is required for action "capture".')
  }
  try {
    const text = await readFile(input.harPath, { encoding: 'utf-8' })
    let requests = parseHar(text)
    if (input.filter) {
      const f = input.filter
      requests = requests.filter(r => r.url.includes(f))
    }
    const sampled = requests.slice(0, input.maxEntries ?? 200)
    const id = workspaceIdFor(input.harPath)
    await writeWorkspaceFile(id, 'requests.json', JSON.stringify(sampled, null, 2))

    return {
      data: {
        success: true,
        action: 'capture',
        message: `Captured ${sampled.length} requests (${requests.length} total, static not yet filtered) into workspace "${id}". Next: action "infer".`,
        workspaceId: id,
        requestCount: sampled.length,
        requests: sampled.slice(0, 20),
      },
    }
  } catch (error) {
    return failure('capture', error instanceof Error ? error.message : String(error))
  }
}

async function loadRequests(input: Input): Promise<{ id: string; requests: Request[] } | { data: Output }> {
  if (!input.harPath) return failure(input.action, 'harPath is required to locate the workspace.')
  const id = workspaceIdFor(input.harPath)
  const requests = await readWorkspaceFile<Request[]>(id, 'requests.json')
  if (!requests) return failure(input.action, `no workspace "${id}". Run action "capture" first.`)
  return { id, requests }
}

async function runInfer(input: Input): Promise<{ data: Output }> {
  const loaded = await loadRequests(input)
  if ('data' in loaded) return loaded
  const endpoints = clusterEndpoints(loaded.requests)
  await writeWorkspaceFile(loaded.id, 'endpoints.json', JSON.stringify(endpoints, null, 2))
  return {
    data: {
      success: true,
      action: 'infer',
      message:
        `${endpoints.length} endpoint(s) inferred:\n` +
        endpointsToMarkdown(endpoints) +
        '\n\nRead this to infer the auth flow / required params / types, then action "generate_client".',
      workspaceId: loaded.id,
      endpoints,
    },
  }
}

async function runExport(input: Input): Promise<{ data: Output }> {
  const loaded = await loadRequests(input)
  if ('data' in loaded) return loaded
  const endpoints = await readWorkspaceFile<Endpoint[]>(loaded.id, 'endpoints.json')
  const list = endpoints ?? clusterEndpoints(loaded.requests)
  const fmt = input.exportFormat ?? 'markdown'
  const content = fmt === 'json' ? JSON.stringify(list, null, 2) : `# Endpoints (${loaded.id})\n\n` + endpointsToMarkdown(list)
  const outPath = `${workspaceDir(loaded.id)}/endpoints.${fmt === 'json' ? 'json' : 'md'}`
  await writeWorkspaceFile(loaded.id, `endpoints.${fmt === 'json' ? 'json' : 'md'}`, content)
  return {
    data: {
      success: true,
      action: 'export',
      message: `Exported ${fmt} to ${outPath}`,
      workspaceId: loaded.id,
      endpoints: list,
      exportedPath: outPath,
    },
  }
}

async function runGenerateClient(input: Input): Promise<{ data: Output }> {
  const loaded = await loadRequests(input)
  if ('data' in loaded) return loaded
  const endpoints = await readWorkspaceFile<Endpoint[]>(loaded.id, 'endpoints.json')
  const list = endpoints ?? clusterEndpoints(loaded.requests)
  const lang = (input.language ?? 'python') as Language
  const brief = buildBrief(list, lang, loaded.id)
  return {
    data: {
      success: true,
      action: 'generate_client',
      message: brief,
      workspaceId: loaded.id,
      endpoints: list,
      brief,
    },
  }
}

async function runReport(input: Input): Promise<{ data: Output }> {
  const loaded = await loadRequests(input)
  if ('data' in loaded) return loaded
  const endpoints = await readWorkspaceFile<Endpoint[]>(loaded.id, 'endpoints.json')
  return {
    data: {
      success: true,
      action: 'report',
      message:
        `Workspace "${loaded.id}": ${loaded.requests.length} requests, ${(endpoints ?? []).length} endpoints.\n\n` +
        (endpoints ? endpointsToMarkdown(endpoints) : '(run "infer" first)'),
      workspaceId: loaded.id,
      requestCount: loaded.requests.length,
      endpoints: endpoints ?? undefined,
    },
  }
}
