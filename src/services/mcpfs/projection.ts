import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { ListPromptsResultSchema, ListResourcesResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer, MCPServerConnection } from '../mcp/types.js'
import type { Tool } from '../../Tool.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { PY_CLIENT, TS_CLIENT } from './runtime.js'
import {
  schemaSummaryLines,
  schemaToPyParams,
  schemaToTs,
  toIdentifier,
  toTsFunctionName,
  toTypeName,
} from './schema.js'

/**
 * mcp-fs: the host's live MCP connections, projected as importable code.
 *
 *   ~/.claude/mcp-fs/servers/
 *     README.md               connected servers, one line each
 *     _mcpfs.ts _mcpfs.py     sandbox client (talks to the host gateway)
 *     __init__.py index.json  python package root; ident → tool map
 *     <server>/README.md      server instructions + tool index
 *     <server>/<tool>.ts|.py  one typed binding per tool
 *     <server>/index.ts __init__.py
 *
 * The tree is a function of the connections: it is rewritten when a server
 * connects or announces tools/list_changed, and a server's directory goes away
 * when the server does. Nothing here talks MCP except the one tools/list per
 * change; every call goes through the gateway to the connection opencc already
 * holds.
 */

export const MCPFS_VERSION = 1
/** Marks a directory this module generated and may replace or delete. */
const GENERATED_MARKER = '.opencc-generated'

export function getMcpFsServersDir(): string {
  return join(getClaudeConfigHomeDir(), 'mcp-fs', 'servers')
}

export type RawMcpTool = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export type ServerSnapshot = {
  name: string
  instructions?: string
  version?: string
  tools: RawMcpTool[]
  resources: boolean
  prompts: boolean
}

export type ProjectedTool = {
  /** Original MCP tool name — what the gateway calls. */
  name: string
  /** File / Python function name. */
  ident: string
  /** TS function name. */
  fn: string
  readOnly: boolean
  destructive: boolean
  openWorld: boolean
  structured: boolean
}

export type ProjectedServer = {
  /** Original MCP server name — what the gateway looks up. */
  name: string
  ident: string
  tools: ProjectedTool[]
  resources: boolean
  prompts: boolean
}

export type ProjectionIndex = {
  version: number
  servers: Record<string, ProjectedServer>
}

// ── rendering (pure) ───────────────────────────────────────────────

function uniqueIdents<T>(items: T[], name: (item: T) => string): Map<T, string> {
  const used = new Set<string>()
  const out = new Map<T, string>()
  for (const item of items) {
    const base = toIdentifier(name(item))
    let ident = base
    for (let n = 2; used.has(ident.toLowerCase()); n++) ident = `${base}_${n}`
    used.add(ident.toLowerCase())
    out.set(item, ident)
  }
  return out
}

function firstLine(text: string | undefined, max = 140): string {
  const line = (text ?? '').trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function hintTags(tool: RawMcpTool): string[] {
  const a = tool.annotations ?? {}
  return [
    a.readOnlyHint ? 'read-only' : '',
    a.destructiveHint ? 'destructive' : '',
    a.idempotentHint ? 'idempotent' : '',
    a.openWorldHint ? 'open-world' : '',
  ].filter(Boolean)
}

function pyString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
}

export function projectServer(snapshot: ServerSnapshot, ident: string): {
  server: ProjectedServer
  files: Map<string, string>
} {
  const tools = [...snapshot.tools].sort((a, b) => a.name.localeCompare(b.name))
  const idents = uniqueIdents(tools, tool => tool.name)
  const files = new Map<string, string>()
  const projected: ProjectedTool[] = []
  const serverLiteral = JSON.stringify(snapshot.name)

  for (const tool of tools) {
    const toolIdent = idents.get(tool)!
    const fn = toTsFunctionName(toolIdent)
    const typeName = toTypeName(toolIdent)
    const structured = Boolean(tool.outputSchema && Object.keys(tool.outputSchema).length > 0)
    const tags = hintTags(tool)
    const toolLiteral = JSON.stringify(tool.name)
    projected.push({
      name: tool.name,
      ident: toolIdent,
      fn,
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
      openWorld: tool.annotations?.openWorldHint === true,
      structured,
    })

    // ── TypeScript ──
    const input = schemaToTs(tool.inputSchema ?? { type: 'object' })
    const output = structured ? schemaToTs(tool.outputSchema) : ''
    const doc = [
      ...(tool.description ?? '').trim().replace(/\*\//g, '* /').split('\n'),
      '',
      `@mcp ${snapshot.name} / ${tool.name}${tags.length ? `  (${tags.join(', ')})` : ''}`,
    ]
    files.set(
      `${toolIdent}.ts`,
      `// Generated by opencc from the live MCP server ${serverLiteral}. Do not edit.\n` +
        `import { callMCPTool${structured ? '' : ', type McpToolOutput'} } from '../_mcpfs.ts'\n\n` +
        `export type ${typeName}Input = ${input}\n\n` +
        (structured ? `export type ${typeName}Output = ${output}\n\n` : '') +
        `/**\n${doc.map(line => ` * ${line}`.trimEnd()).join('\n')}\n */\n` +
        `export function ${fn}(input: ${typeName}Input${isEmptyInput(tool) ? ' = {}' : ''}): Promise<${structured ? `${typeName}Output` : 'McpToolOutput'}> {\n` +
        `  return callMCPTool(${serverLiteral}, ${toolLiteral}, input as Record<string, unknown>${structured ? ', { structured: true }' : ''})\n` +
        `}\n`,
    )

    // ── Python ──
    const params = schemaToPyParams(tool.inputSchema)
    const signature = params
      ? params.length === 0
        ? ''
        : `*, ${params.map(p => (p.required ? `${p.keyword}: ${p.annotation}` : `${p.keyword}: ${p.annotation} | None = None`)).join(', ')}`
      : '**args: Any'
    // kwargs → the JSON object the tool expects; None means "not given".
    const collect =
      params && params.length > 0
        ? `    args = {k: v for k, v in {${params.map(p => `${JSON.stringify(p.name)}: ${p.keyword}`).join(', ')}}.items() if v is not None}\n`
        : ''
    const argsExpr = params && params.length === 0 ? '{}' : 'args'
    const summary = schemaSummaryLines(tool.inputSchema)
    const pyDoc = [
      pyString((tool.description ?? tool.name).trim()),
      '',
      ...(summary.length ? ['Args:', ...summary.map(line => `    ${pyString(line)}`), ''] : []),
      structured
        ? `Returns: dict matching the tool's outputSchema (see ${toolIdent}.ts for the exact shape).`
        : 'Returns: ToolOutput with .text, .json (parsed, or None) and .content (raw MCP blocks).',
      `MCP: ${pyString(snapshot.name)} / ${pyString(tool.name)}${tags.length ? `  (${tags.join(', ')})` : ''}`,
    ]
    files.set(
      `${toolIdent}.py`,
      `# Generated by opencc from the live MCP server ${serverLiteral}. Do not edit.\n` +
        `from typing import Any, Literal  # noqa: F401\n` +
        `from servers._mcpfs import call_tool\n\n\n` +
        `def ${toolIdent}(${signature}):\n` +
        `    """${pyDoc.join('\n    ').trimEnd()}\n    """\n` +
        collect +
        `    return call_tool(${serverLiteral}, ${toolLiteral}, ${argsExpr}, structured=${structured ? 'True' : 'False'})\n`,
    )
  }

  files.set(
    'index.ts',
    `// Generated by opencc. One import per tool keeps approval precise.\n` +
      projected.map(tool => `export { ${tool.fn} } from './${tool.ident}.ts'`).join('\n') +
      '\n',
  )
  // Eager on purpose. Each tool module is named after its function, and
  // importing a submodule binds the *module* on the package; a lazy
  // __getattr__ therefore handed back a module where a function was asked for,
  // depending on import order. Importing every function here, once, makes the
  // package attribute the function no matter which form the code uses first.
  files.set(
    '__init__.py',
    `# Generated by opencc.\n` +
      projected.map(tool => `from .${tool.ident} import ${tool.ident}`).join('\n') +
      `\n\n__all__ = [${projected.map(tool => JSON.stringify(tool.ident)).join(', ')}]\n`,
  )

  const readme = [
    `# ${snapshot.name}${snapshot.version ? ` (v${snapshot.version})` : ''}`,
    '',
    'Live MCP server, callable from CodeAct. Calls run on opencc\'s own connection, so',
    'server-side state persists across calls and runs. Results stay in your code;',
    'print only what you need.',
    '',
    '```ts',
    `import { ${projected[0]?.fn ?? 'someTool'} } from './servers/${ident}/index.ts'`,
    '```',
    '```python',
    `from servers.${ident} import ${projected[0]?.ident ?? 'some_tool'}`,
    '```',
    '',
    'Tools not marked read-only are approved once per run from the imports in your',
    'code, so import them by name — a tool reached only through a dynamic name is refused.',
    '',
    ...(snapshot.instructions?.trim() ? ['## Server instructions', '', snapshot.instructions.trim(), ''] : []),
    `## Tools (${projected.length})`,
    '',
    ...tools.map(tool => {
      const p = projected.find(entry => entry.name === tool.name)!
      const tags = hintTags(tool)
      return `- \`${p.ident}\` / \`${p.fn}\`${tags.length ? ` [${tags.join(', ')}]` : ''}${p.structured ? ' → typed result' : ''} — ${firstLine(tool.description)}`
    }),
    '',
    ...(snapshot.resources ? ['Resources: `listResources(server)` / `readResource(server, uri)` from `../_mcpfs.ts` (Python: `list_resources`, `read_resource`).', ''] : []),
    ...(snapshot.prompts ? ['Prompts: `getPrompt(server, name, args)` from `../_mcpfs.ts` (Python: `get_prompt`).', ''] : []),
  ]
  files.set('README.md', readme.join('\n'))
  files.set(GENERATED_MARKER, `${snapshot.name}\n`)

  return {
    server: { name: snapshot.name, ident, tools: projected, resources: snapshot.resources, prompts: snapshot.prompts },
    files,
  }
}

function isEmptyInput(tool: RawMcpTool): boolean {
  const props = tool.inputSchema?.properties
  const required = tool.inputSchema?.required
  return (!props || Object.keys(props as object).length === 0) && (!Array.isArray(required) || required.length === 0)
}

export function renderRoot(index: ProjectionIndex): Map<string, string> {
  const servers = Object.values(index.servers).sort((a, b) => a.ident.localeCompare(b.ident))
  return new Map([
    ['_mcpfs.ts', TS_CLIENT],
    ['_mcpfs.py', PY_CLIENT],
    ['__init__.py', '# Generated by opencc: MCP servers as Python packages.\n'],
    ['index.json', `${JSON.stringify(index, null, 2)}\n`],
    [
      'README.md',
      [
        '# MCP servers (live)',
        '',
        'Each directory is a connected MCP server. Read its README.md, then import',
        'tools in CodeAct — TypeScript `./servers/<server>/index.ts`, Python `servers.<server>`.',
        '',
        ...servers.map(server => {
          const writable = server.tools.filter(tool => !tool.readOnly).length
          return `- \`${server.ident}/\` — ${server.name}: ${server.tools.length} tools (${writable} not read-only)`
        }),
        '',
      ].join('\n'),
    ],
  ])
}

// ── fetching ───────────────────────────────────────────────────────

export async function fetchServerSnapshot(connection: ConnectedMCPServer): Promise<ServerSnapshot> {
  const tools: RawMcpTool[] = []
  if (connection.capabilities?.tools) {
    let cursor: string | undefined
    do {
      const page = await connection.client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
      )
      tools.push(...(page.tools as RawMcpTool[]))
      cursor = page.nextCursor
    } while (cursor)
  }
  return {
    name: connection.name,
    instructions: connection.instructions,
    version: connection.serverInfo?.version,
    tools,
    resources: Boolean(connection.capabilities?.resources),
    prompts: Boolean(connection.capabilities?.prompts),
  }
}

// ── writing ────────────────────────────────────────────────────────

async function isGenerated(dir: string): Promise<boolean> {
  return existsSync(join(dir, GENERATED_MARKER))
}

/** Replace `<root>/<ident>` with `files`, atomically from a reader's view. */
async function writeServerDir(root: string, ident: string, files: Map<string, string>): Promise<void> {
  const target = join(root, ident)
  if (existsSync(target) && !(await isGenerated(target))) {
    throw new Error(`${target} exists and was not generated by opencc; leaving it alone`)
  }
  const staging = join(root, `.staging-${ident}-${randomUUID().slice(0, 8)}`)
  await mkdir(staging, { recursive: true })
  for (const [path, body] of files) {
    await mkdir(dirname(join(staging, path)), { recursive: true })
    await writeFile(join(staging, path), body, 'utf8')
  }
  const retired = join(root, `.retired-${ident}-${randomUUID().slice(0, 8)}`)
  if (existsSync(target)) await rename(target, retired)
  await rename(staging, target)
  await rm(retired, { recursive: true, force: true })
}

async function writeRootFiles(root: string, files: Map<string, string>): Promise<void> {
  await mkdir(root, { recursive: true })
  for (const [path, body] of files) {
    const target = join(root, path)
    const current = existsSync(target) ? await readFile(target, 'utf8').catch(() => '') : ''
    if (current === body) continue
    const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(temp, body, 'utf8')
    await rename(temp, target)
  }
}

// ── the projector ──────────────────────────────────────────────────

let connectionIds = new WeakMap<object, number>()
let nextConnectionId = 1
const connectionId = (connection: object): number => {
  let id = connectionIds.get(connection)
  if (id === undefined) {
    id = nextConnectionId++
    connectionIds.set(connection, id)
  }
  return id
}

/**
 * Keeps the tree in step with the connections.
 *
 * `sync` is cheap to call on every app-state change: it fingerprints each
 * server from what app state already holds (connection identity + tool names
 * and input schemas) and only refetches tools/list for a server whose
 * fingerprint moved — a (re)connect or a tools/list_changed refresh.
 */
export class McpFsProjector {
  private readonly fingerprints = new Map<string, string>()
  private index: ProjectionIndex = { version: MCPFS_VERSION, servers: {} }
  private running: Promise<void> = Promise.resolve()
  /** Root files are compared once per process, so an upgraded client lands. */
  private rootChecked = false

  constructor(readonly root: string = getMcpFsServersDir()) {}

  getIndex(): ProjectionIndex {
    return this.index
  }

  sync(clients: readonly MCPServerConnection[], tools: readonly Tool[]): Promise<void> {
    const work = this.running.then(() => this.syncNow(clients, tools))
    this.running = work.catch(error => logForDebugging(`[mcp-fs] projection failed: ${error}`))
    return work
  }

  private async syncNow(clients: readonly MCPServerConnection[], tools: readonly Tool[]): Promise<void> {
    const connected = clients.filter((c): c is ConnectedMCPServer => c.type === 'connected')
    // Pending servers are reconnecting: keep their files rather than churn.
    const keep = new Set(clients.filter(c => c.type === 'pending').map(c => c.name))
    const servers = { ...this.index.servers }
    const identOf = (name: string) =>
      Object.values(servers).find(server => server.name === name)?.ident
    let changed = false

    for (const connection of connected) {
      const own = tools
        .filter(tool => tool.mcpInfo?.serverName === connection.name)
        .map(tool => [
          tool.mcpInfo?.toolName,
          tool.inputJSONSchema,
          tool.mcpOutputJSONSchema,
          tool.mcpDescription,
          tool.mcpAnnotations,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      const fingerprint = `${connectionId(connection)}:${JSON.stringify(own)}`
      if (this.fingerprints.get(connection.name) === fingerprint && identOf(connection.name)) continue

      const snapshot = await fetchServerSnapshot(connection)
      const ident =
        identOf(connection.name) ??
        uniqueServerIdent(connection.name, new Set(Object.keys(servers)))
      const { server, files } = projectServer(snapshot, ident)
      await writeServerDir(this.root, ident, files)
      servers[ident] = server
      this.fingerprints.set(connection.name, fingerprint)
      changed = true
      logForDebugging(`[mcp-fs] projected ${connection.name} → ${ident}/ (${server.tools.length} tools)`)
    }

    const live = new Set(connected.map(c => c.name))
    for (const [ident, server] of Object.entries(servers)) {
      if (live.has(server.name) || keep.has(server.name)) continue
      delete servers[ident]
      this.fingerprints.delete(server.name)
      const dir = join(this.root, ident)
      if (await isGenerated(dir)) await rm(dir, { recursive: true, force: true })
      changed = true
    }

    if (changed || !this.rootChecked) {
      this.index = { version: MCPFS_VERSION, servers }
      await writeRootFiles(this.root, renderRoot(this.index))
      await this.sweepOrphans(new Set(Object.keys(servers)))
      this.rootChecked = true
    }
  }

  /** Generated directories from an earlier process for servers no longer configured. */
  private async sweepOrphans(known: Set<string>): Promise<void> {
    let entries: string[] = []
    try {
      entries = await readdir(this.root)
    } catch {
      return
    }
    for (const entry of entries) {
      const dir = join(this.root, entry)
      if (entry.startsWith('.staging-') || entry.startsWith('.retired-')) {
        await rm(dir, { recursive: true, force: true })
      } else if (!known.has(entry) && !entry.includes('.') && entry !== '__pycache__' && (await isGenerated(dir))) {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}

function uniqueServerIdent(name: string, taken: Set<string>): string {
  const base = toIdentifier(name)
  let ident = base
  for (let n = 2; taken.has(ident); n++) ident = `${base}_${n}`
  return ident
}

let projector: McpFsProjector | undefined
let pending: ReturnType<typeof setTimeout> | undefined

export function getMcpFsProjector(): McpFsProjector {
  projector ??= new McpFsProjector()
  return projector
}

/** For tests: forget the singleton and connection identities. */
export function resetMcpFsProjectorForTests(next?: McpFsProjector): void {
  projector = next
  connectionIds = new WeakMap()
}

/**
 * Called from onChangeAppState whenever the mcp slice changes. Debounced:
 * a burst of connects at startup becomes one pass.
 */
export function scheduleMcpFsProjection(
  clients: readonly MCPServerConnection[],
  tools: readonly Tool[],
): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = undefined
    void getMcpFsProjector().sync(clients, tools)
  }, 250)
  pending.unref?.()
}
