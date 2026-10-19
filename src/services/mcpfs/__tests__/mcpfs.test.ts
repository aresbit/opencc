import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

/**
 * mcp-fs end to end, against a real MCP server over the in-process transport:
 * projection → typed TS/Python bindings → CodeAct code → gateway → the same
 * live connection → back, with the one-time approval enforced in between.
 *
 * Config lives in a temp dir, and modules are imported after it is set, so
 * nothing here touches the real ~/.claude.
 */

const home = mkdtempSync(join(tmpdir(), 'mcpfs-test-'))
process.env.CLAUDE_CONFIG_DIR = home

let mods: {
  projection: typeof import('../projection.js')
  approval: typeof import('../approval.js')
  sandbox: typeof import('../../../utils/codeActSandbox.js')
  tool: typeof import('../../../Tool.js')
}

let total = 0
let tools: Array<Record<string, unknown>>
let server: Server
let connection: any
let appState: any

function context(mode = 'default', rules: Record<string, string[]> = {}) {
  appState = {
    mcp: { clients: [connection], tools: [] },
    toolPermissionContext: {
      ...mods.tool.getEmptyToolPermissionContext(),
      mode,
      alwaysDenyRules: rules.deny ? { localSettings: rules.deny } : {},
      alwaysAllowRules: rules.allow ? { localSettings: rules.allow } : {},
    },
  }
  return {
    getAppState: () => appState,
    setAppState: () => {},
    options: { mcpClients: [connection] },
    abortController: new AbortController(),
  } as any
}

async function run(code: string, language: 'typescript' | 'python', ctx = context()) {
  const mcp = await mods.approval.openMcpRun(code, language, ctx, ctx.abortController.signal)
  try {
    return await mods.sandbox.executeCodeActCode(code, {
      language,
      environment: mcp.environment,
      mcpServersDir: mcp.serversDir,
      timeoutMs: 60_000,
    })
  } finally {
    mcp.close()
  }
}

beforeAll(async () => {
  mods = {
    projection: await import('../projection.js'),
    approval: await import('../approval.js'),
    sandbox: await import('../../../utils/codeActSandbox.js'),
    tool: await import('../../../Tool.js'),
  }
  tools = [
    {
      name: 'counter_add',
      description: 'Add n to the server-side counter.',
      inputSchema: { type: 'object', properties: { n: { type: 'integer', description: 'amount' } }, required: ['n'] },
      outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] },
    },
    {
      name: 'counter_get',
      description: 'Read the counter.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'wipe',
      description: 'Reset the counter.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { destructiveHint: true },
    },
    {
      name: 'big',
      description: 'A result far past what the model-facing path keeps.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ]
  server = new Server(
    { name: 'demo', version: '1.2.3' },
    { capabilities: { tools: { listChanged: true }, resources: {} }, instructions: 'Demo counter server.' },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as never }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    switch (request.params.name) {
      case 'counter_add':
        total += Number(request.params.arguments?.n ?? 0)
        return { content: [{ type: 'text', text: JSON.stringify({ total }) }], structuredContent: { total } }
      case 'counter_get':
        return { content: [{ type: 'text', text: JSON.stringify({ total }) }] }
      case 'wipe':
        total = 0
        return { content: [{ type: 'text', text: 'wiped' }] }
      case 'big':
        return { content: [{ type: 'text', text: 'x'.repeat(200_000) }] }
      default:
        return { isError: true, content: [{ type: 'text', text: 'no such tool' }] }
    }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'mem://notes', name: 'notes' }],
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async request => ({
    contents: [{ uri: request.params.uri, text: 'hello notes' }],
  }))
  const { createLinkedTransportPair } = await import('../../mcp/InProcessTransport.js')
  const [clientSide, serverSide] = createLinkedTransportPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'mcpfs-test', version: '1' }, { capabilities: {} })
  await client.connect(clientSide)
  connection = {
    client,
    name: 'demo',
    type: 'connected',
    capabilities: client.getServerCapabilities(),
    instructions: client.getInstructions(),
    serverInfo: client.getServerVersion(),
    config: { type: 'sdk', name: 'demo', scope: 'local' },
    cleanup: async () => {},
  }
  mods.projection.resetMcpFsProjectorForTests(
    new mods.projection.McpFsProjector(join(home, 'mcp-fs', 'servers')),
  )
  await mods.projection.getMcpFsProjector().sync([connection], [])
})

afterAll(async () => {
  await server.close()
})

const root = () => mods.projection.getMcpFsProjector().root

describe('projection', () => {
  test('writes typed TS and Python bindings from the live schemas', () => {
    const add = readFileSync(join(root(), 'demo', 'counter_add.ts'), 'utf8')
    expect(add).toContain('export type CounterAddInput = {')
    expect(add).toContain('n: number;')
    expect(add).toContain('export type CounterAddOutput = {')
    expect(add).toContain('Promise<CounterAddOutput>')
    expect(readFileSync(join(root(), 'demo', 'counter_get.ts'), 'utf8')).toContain('Promise<McpToolOutput>')
    expect(readFileSync(join(root(), 'demo', 'counter_add.py'), 'utf8')).toContain('def counter_add(*, n: int):')
    const readme = readFileSync(join(root(), 'demo', 'README.md'), 'utf8')
    expect(readme).toContain('Demo counter server.')
    expect(readme).toContain('[read-only]')
    const index = JSON.parse(readFileSync(join(root(), 'index.json'), 'utf8'))
    expect(index.servers.demo.tools.find((t: any) => t.name === 'counter_get').readOnly).toBe(true)
  })

  test('tools/list_changed rewrites the server; a hand-made directory is left alone', async () => {
    mkdirSync(join(root(), 'handmade'), { recursive: true })
    writeFileSync(join(root(), 'handmade', 'mine.ts'), 'export {}')
    tools.push({ name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } })
    // What a list_changed refresh looks like from app state: new tool objects.
    await mods.projection.getMcpFsProjector().sync([connection], [
      { mcpInfo: { serverName: 'demo', toolName: 'echo' }, inputJSONSchema: {} } as never,
    ])
    expect(existsSync(join(root(), 'demo', 'echo.ts'))).toBe(true)
    expect(existsSync(join(root(), 'handmade', 'mine.ts'))).toBe(true)
    tools.pop()
  })
})

describe('one-time approval', () => {
  const code = `import { counterAdd, counterGet, wipe } from './servers/demo/index.ts'`

  test('lists exactly the referenced tools that are not read-only', async () => {
    const check = await mods.approval.mcpPermissionCheck(code, 'typescript', context())
    expect(check.kind).toBe('ask')
    if (check.kind === 'ask') {
      expect(check.pending.map(ref => ref.tool).sort()).toEqual(['counter_add', 'wipe'])
    }
  })

  test('read-only code, bypass mode, and allow rules need no prompt', async () => {
    const readOnly = `from servers.demo import counter_get`
    expect((await mods.approval.mcpPermissionCheck(readOnly, 'python', context())).kind).toBe('none')
    expect((await mods.approval.mcpPermissionCheck(code, 'typescript', context('bypassPermissions'))).kind).toBe('none')
    const allowed = context('default', { allow: ['mcp__demo'] })
    expect((await mods.approval.mcpPermissionCheck(code, 'typescript', allowed)).kind).toBe('none')
  })

  test('a deny rule on a referenced tool refuses the run outright', async () => {
    const denied = context('default', { deny: ['mcp__demo__wipe'] })
    const check = await mods.approval.mcpPermissionCheck(code, 'typescript', denied)
    expect(check.kind).toBe('deny')
  })
})

describe('calls from CodeAct go through the live connection', () => {
  test('TypeScript: typed result, and server-side state persists across calls', async () => {
    total = 0
    const result = await run(
      `import { counterAdd, counterGet } from './servers/demo/index.ts'
await counterAdd({ n: 2 })
const after = await counterAdd({ n: 3 })
const read = await counterGet()
console.log(after.total, (read.json as { total: number }).total)`,
      'typescript',
    )
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('5 5')
    expect(total).toBe(5)
  })

  test('Python: same server, same state', async () => {
    const result = await run(
      `from servers.demo import counter_add, counter_get
print(counter_add(n=4)["total"], counter_get().json["total"])`,
      'python',
    )
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('9 9')
  })

  test('a large result reaches the code whole', async () => {
    const result = await run(
      `import { big } from './servers/demo/index.ts'
console.log((await big()).text.length)`,
      'typescript',
    )
    expect(result.stdout.trim()).toBe('200000')
  })

  test('resources are readable from code', async () => {
    const result = await run(
      `from servers._mcpfs import read_resource
print(read_resource("demo", "mem://notes")["contents"][0]["text"])`,
      'python',
    )
    expect(result.stdout.trim()).toBe('hello notes')
  })

  test('a tool reached only through a dynamic name is refused, and nothing runs', async () => {
    total = 7
    const result = await run(
      `import { callMCPTool } from './servers/_mcpfs.ts'
const name = ['wi', 'pe'].join('')
try { await callMCPTool('demo', name) } catch (e) { console.log((e as { code: string }).code) }`,
      'typescript',
    )
    expect(result.stdout.trim()).toBe('not_approved')
    expect(total).toBe(7)
  })

  test('the same tool imported by name is allowed once approved', async () => {
    const result = await run(
      `import { wipe } from './servers/demo/index.ts'
console.log((await wipe()).text)`,
      'typescript',
    )
    expect(result.stdout.trim()).toBe('wiped')
    expect(total).toBe(0)
  })

  test('a closed session is refused', async () => {
    const ctx = context()
    const mcp = await mods.approval.openMcpRun(`import { counterGet } from './servers/demo/index.ts'`, 'typescript', ctx)
    mcp.close()
    const result = await mods.sandbox.executeCodeActCode(
      `import { counterGet } from './servers/demo/index.ts'
try { await counterGet() } catch (e) { console.log((e as { code: string }).code) }`,
      { language: 'typescript', environment: mcp.environment, mcpServersDir: mcp.serversDir },
    )
    expect(result.stdout.trim()).toBe('unauthorized')
  })
})

describe('disconnect', () => {
  test("a server that goes away takes its directory with it", async () => {
    await mods.projection.getMcpFsProjector().sync([], [])
    expect(existsSync(join(root(), 'demo'))).toBe(false)
    expect(existsSync(join(root(), 'handmade', 'mine.ts'))).toBe(true)
  })
})
