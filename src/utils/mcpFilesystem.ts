import { readFile, readdir, mkdir, writeFile, rm, copyFile } from 'fs/promises'
import { join, resolve, relative } from 'path'
import { existsSync } from 'fs'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import { spawn } from 'child_process'

/**
 * MCP Filesystem Engine — Anthropic Code-Execution Aligned
 * =========================================================
 * Implements the architecture from:
 *   https://www.anthropic.com/engineering/code-execution-with-mcp
 *
 * Key design decisions (from Anthropic spec):
 * 1. Tools are TypeScript files under ./servers/<server>/<tool>.ts
 * 2. Discovery is via filesystem traversal (ls + read individual files)
 * 3. Execution is via code sandbox — agent writes TS, we execute it
 * 4. Intermediate results stay in execution env (not in model context)
 * 5. Only console.log output reaches the model
 * 6. callMCPTool bridges TS function calls → actual tool execution
 *
 * Directory structure:
 *   ~/.claude/mcp-fs/
 *   ├── client.ts                  ← callMCPTool bridge
 *   ├── servers/                   ← Generated tool wrappers
 *   │   └── <server>/
 *   │       ├── index.ts           ← Barrel re-export
 *   │       └── <tool>.ts          ← One file per tool
 *   ├── workspace/                 ← Agent state persistence
 *   ├── skills/                    ← Reusable agent functions
 *   └── cache/                     ← Execution result cache
 */

// ── Types ────────────────────────────────────────────────────────

export interface McpFsToolDef {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  /** Shell command for simple exec mode (fallback) */
  command?: string
  /** Alternative: MCP server-tool reference for callMCPTool */
  mcpServer?: string
  mcpToolName?: string
  readOnly?: boolean
  destructive?: boolean
}

export interface McpFsManifest {
  server: string
  version: string
  description?: string
  tools: McpFsToolDef[]
}

export interface McpFsRegistryEntry {
  server: string
  toolName: string
  description: string
  tsFilePath: string
  command?: string
  mcpServer?: string
  mcpToolName?: string
  inputSchema?: Record<string, unknown>
  readOnly: boolean
  destructive: boolean
}

export interface CodeExecResult {
  success: boolean
  stdout: string
  stderr: string
  exitCode: number
  /** Files written to workspace during execution */
  workspaceFiles: string[]
}

// ── Paths ────────────────────────────────────────────────────────

export function getMcpFsBaseDir(): string {
  return join(getClaudeConfigHomeDir(), 'mcp-fs')
}

function getServersDir(): string {
  return join(getMcpFsBaseDir(), 'servers')
}

export function getWorkspaceDir(): string {
  return join(getMcpFsBaseDir(), 'workspace')
}

export function getSkillsDir(): string {
  return join(getMcpFsBaseDir(), 'skills')
}

function getCacheDir(): string {
  return join(getMcpFsBaseDir(), 'cache')
}

function getClientTsPath(): string {
  return join(getMcpFsBaseDir(), 'client.ts')
}

export function getSandboxDir(): string {
  return join(getMcpFsBaseDir(), 'sandbox')
}

function getBridgePath(): string {
  return join(getMcpFsBaseDir(), 'bridge.mjs')
}

/**
 * Ensure bridge.mjs exists in the mcp-fs directory. Tries, in order:
 * 1. Already present — no-op.
 * 2. Copy from the repo source (`src/utils/mcpBridge.mjs` relative to
 *    the project root, which works in dev mode).
 * 3. Fall back to a minimal inline bridge that can at least list tools
 *    from stdio-based MCP servers (no SSE/streamable support).
 *
 * Without this, every `probeMcpServerTools()` call silently returned []
 * because `!existsSync(bridgePath)` short-circuited before any probe.
 */
async function ensureBridge(): Promise<void> {
  const dest = getBridgePath()
  if (existsSync(dest)) return

  // Try repo-relative copy first (dev mode).
  try {
    const { getProjectRoot } = await import('../bootstrap/state.js')
    const src = join(getProjectRoot() as string, 'src', 'utils', 'mcpBridge.mjs')
    if (existsSync(src)) {
      await mkdir(getMcpFsBaseDir(), { recursive: true })
      await copyFile(src, dest)
      return
    }
  } catch { /* fall through to inline generation */ }

  // Fallback: minimal bridge — can list tools + call via stdio transport
  // (covers 95% of MCP servers). SSE / streamable transports need the full
  // bridge; copy it manually or run scripts/chatwise-to-mcpfs.ts.
  const minimalBridge = `#!/usr/bin/env node
// Minimal MCP-FS bridge — lists tools and calls via stdio transport.
// For SSE / streamable HTTP transports, copy the full bridge from:
//   cp src/utils/mcpBridge.mjs ~/.claude/mcp-fs/bridge.mjs
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';

const MODE = process.env.BRIDGE_TOOL ? 'call' : 'list';

async function main() {
  const configStr = process.env.BRIDGE_SERVER_CONFIG;
  if (!configStr) {
    console.log(JSON.stringify({error:'no BRIDGE_SERVER_CONFIG'}));
    process.exit(1);
  }
  const config = JSON.parse(configStr);
  const {command, args = [], env = {}} = config;
  if (!command) {
    // URL-based servers (SSE) — can't probe with minimal bridge
    console.log(JSON.stringify({tools:[]}));
    process.exit(0);
  }

  const child = spawn(command, args, {
    env: {...process.env, ...env},
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });

  // MCP handshake: initialize
  child.stdin.write(JSON.stringify({
    jsonrpc:'2.0', id:1, method:'initialize',
    params:{protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'mcpfs-bridge',version:'0.1'}}
  }) + '\\n');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized'}) + '\\n');

  if (MODE === 'list') {
    child.stdin.write(JSON.stringify({
      jsonrpc:'2.0', id:2, method:'tools/list', params:{}
    }) + '\\n');
  } else {
    const toolName = process.env.BRIDGE_TOOL;
    const argsStr = process.env.BRIDGE_TOOL_ARGS || '{}';
    child.stdin.write(JSON.stringify({
      jsonrpc:'2.0', id:3, method:'tools/call',
      params:{name:toolName, arguments:JSON.parse(argsStr)}
    }) + '\\n');
  }

  await new Promise(r => setTimeout(r, 3000));
  child.stdin.end();

  try {
    // Parse JSON-RPC responses from stdout
    const lines = stdout.split('\\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (MODE === 'list' && msg.result?.tools) {
          console.log(JSON.stringify(msg.result));
          process.exit(0);
        }
        if (MODE === 'call' && msg.result !== undefined) {
          console.log(JSON.stringify(msg.result));
          process.exit(0);
        }
      } catch {}
    }
    console.log(JSON.stringify({tools:[]}));
  } catch {
    console.log(JSON.stringify({tools:[]}));
  }
}
main();
`
  try {
    await mkdir(getMcpFsBaseDir(), { recursive: true })
    await writeFile(dest, minimalBridge)
  } catch { /* best-effort */ }
}

// ── Tool .ts File Generation ─────────────────────────────────────

/**
 * Generate the TypeScript wrapper file for a single tool.
 * Follows Anthropic's exact pattern:
 *   - Typed Input/Response interfaces
 *   - JSDoc description
 *   - Exported async function calling callMCPTool
 */
function generateToolTs(entry: McpFsRegistryEntry): string {
  const funcName = toCamelCase(entry.toolName)
  const interfaceName = capitalize(funcName)

  const inputFields = extractInputFields(entry.inputSchema)
  const hasInput = inputFields.length > 0

  const inputIface = hasInput
    ? `\ninterface ${interfaceName}Input {\n${inputFields.map(f => `  ${f.name}${f.optional ? '?' : ''}: ${f.type};`).join('\n')}\n}\n`
    : ''

  const responseIface = `\ninterface ${interfaceName}Response {\n  [key: string]: unknown;\n}\n`

  const qualifier = entry.mcpServer && entry.mcpToolName
    ? `${entry.mcpServer}__${entry.mcpToolName}`
    : `${entry.server}__${entry.toolName}`

  return `import { callMCPTool } from "../../client.js";
${inputIface}${responseIface}
/** ${entry.description} */
export async function ${funcName}(${hasInput ? `input: ${interfaceName}Input` : ''}): Promise<${interfaceName}Response> {
  return callMCPTool<${interfaceName}Response>('${qualifier}'${hasInput ? ', input' : ', {}'});
}
`
}

/**
 * Generate index.ts barrel file that re-exports all tools in a server.
 */
function generateIndexTs(serverName: string, tools: McpFsRegistryEntry[]): string {
  const lines: string[] = []
  for (const t of tools) {
    const funcName = toCamelCase(t.toolName)
    lines.push(`export { ${funcName} } from './${t.toolName}.js';`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Generate the shared client.ts with callMCPTool bridge function.
 */
function generateClientTs(): string {
  return `/**
 * MCP Tool Bridge — Translates TypeScript function calls into
 * tool execution (shell commands or MCP wire protocol).
 *
 * This is the bridge between agent-written code and the real world.
 * From Anthropic's spec: "callMCPTool bridges between in-process
 * JavaScript execution and the actual tool invocation."
 */

type ToolResult<T> = T & { _meta?: Record<string, unknown> };

/**
 * Call an MCP tool by its fully-qualified server__tool name.
 * The implementation delegates to shell execution via environment
 * variables (MCP_ARG_*) or to the real MCP client if available.
 */
export async function callMCPTool<T = Record<string, unknown>>(
  qualifiedName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const [server, ...toolParts] = qualifiedName.split('__');
  const toolName = toolParts.join('__');

  // Build environment for subprocess execution
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    MCP_SERVER: server!,
    MCP_TOOL: toolName,
    MCP_TOOL_DIR: \`./servers/\${server}\`,
  };

  // Pass args as JSON to preserve camelCase parameter names
  env['MCP_ARGS'] = JSON.stringify(args);

  // Find the tool's command from its registry entry
  const registryPath = './registry.json';
  let command = '';
  try {
    const fs = await import('fs/promises');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
    const entry = registry.find(
      (e: { server: string; toolName: string }) =>
        e.server === server && e.toolName === toolName,
    );
    if (entry?.command) {
      command = entry.command;
    } else {
      // No explicit command — return structured error
      return {
        error: \`Tool \${qualifiedName} has no command defined. Tool exists but cannot be executed directly.\`,
        _meta: { server, toolName, qualifiedName },
      } as unknown as T;
    }
  } catch {
    return {
      error: \`Tool registry not found. Run mcpfs_discover first.\`,
      _meta: { server, toolName, qualifiedName },
    } as unknown as T;
  }

  // Execute via subprocess
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim() || '{}');
        if (code !== 0) {
          result._meta = { ...result._meta, exitCode: code, stderr };
        }
        resolve(result as T);
      } catch {
        resolve({
          _stdout: stdout.trim(),
          _stderr: stderr.trim(),
          _exitCode: code,
        } as unknown as T);
      }
    });

    child.on('error', (err) => {
      resolve({
        error: err.message,
        _meta: { server, toolName },
      } as unknown as T);
    });
  });
}
`
}

/**
 * Generate all tool .ts files and the index.ts barrel from discovered tools.
 * Also generates client.ts if it doesn't exist.
 */
export async function generateToolFiles(
  entries: McpFsRegistryEntry[],
): Promise<{ filesWritten: string[] }> {
  const filesWritten: string[] = []

  // Group by server
  const byServer = new Map<string, McpFsRegistryEntry[]>()
  for (const entry of entries) {
    const list = byServer.get(entry.server) || []
    list.push(entry)
    byServer.set(entry.server, list)
  }

  for (const [server, tools] of byServer) {
    const serverDir = join(getServersDir(), server)
    await mkdir(serverDir, { recursive: true })

    // Write individual tool .ts files
    for (const tool of tools) {
      const tsContent = generateToolTs(tool)
      const tsPath = join(serverDir, `${tool.toolName}.ts`)
      await writeFile(tsPath, tsContent)
      filesWritten.push(tsPath)
    }

    // Write index.ts barrel
    const indexPath = join(serverDir, 'index.ts')
    await writeFile(indexPath, generateIndexTs(server, tools))
    filesWritten.push(indexPath)
  }

  // Write client.ts if missing
  const clientPath = getClientTsPath()
  if (!existsSync(clientPath)) {
    await mkdir(getMcpFsBaseDir(), { recursive: true })
    await writeFile(clientPath, generateClientTs())
    filesWritten.push(clientPath)
  }

  // Write registry.json
  const registryPath = join(getMcpFsBaseDir(), 'registry.json')
  const serialized = jsonStringify(entries, 2)
  await writeFile(registryPath, serialized)
  lastRegistryJson = serialized
  filesWritten.push(registryPath)

  // Mutation: bust the read-cache so the next read sees fresh entries.
  invalidateDiscoverToolsCache()

  return { filesWritten }
}

// ── Code Execution Sandbox ───────────────────────────────────────

/**
 * Execute agent-written TypeScript code in an isolated Bun sandbox.
 *
 * This is the core innovation from Anthropic's spec:
 *   "The agent writes code → the execution environment runs it →
 *    only console.log output reaches the model."
 *
 * The sandbox:
 * 1. Receives TypeScript code from the agent
 * 2. Splices it together with the client.ts import
 * 3. Spawns `bun run` in an isolated temp directory
 * 4. Captures stdout (console.log), stderr, exit code
 * 5. Only stdout is returned to the model
 *
 * Intermediate results from callMCPTool calls stay in the sandbox
 * process — they never enter the model's context window.
 */
export async function executeCode(
  code: string,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    env?: Record<string, string>
  },
): Promise<CodeExecResult> {
  const sandboxDir = join(getSandboxDir(), `exec_${Date.now()}`)
  await mkdir(sandboxDir, { recursive: true })

  // Ensure workspace exists
  const workspaceDir = getWorkspaceDir()
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(getSkillsDir(), { recursive: true })

  // Copy client.ts into sandbox
  const clientPath = getClientTsPath()
  if (!existsSync(clientPath)) {
    await mkdir(getMcpFsBaseDir(), { recursive: true })
    await writeFile(clientPath, generateClientTs())
  }
  const clientContent = await readFile(clientPath, 'utf-8')
  await writeFile(join(sandboxDir, 'client.ts'), clientContent)

  // Symlink servers directory into sandbox so agent code can import tools
  const serversDir = getServersDir()
  const sandboxServersDir = join(sandboxDir, 'servers')
  if (existsSync(serversDir)) {
    try {
      const { symlink } = await import('fs/promises')
      await symlink(serversDir, sandboxServersDir, 'dir')
    } catch {
      // Fallback: copy servers directory
      try {
        const { cp } = await import('fs/promises')
        await cp(serversDir, sandboxServersDir, { recursive: true })
      } catch { /* best effort */ }
    }
  }

  // Copy registry
  const registryPath = join(getMcpFsBaseDir(), 'registry.json')
  if (existsSync(registryPath)) {
    await writeFile(
      join(sandboxDir, 'registry.json'),
      await readFile(registryPath, 'utf-8'),
    )
  }

  // Write agent code
  const agentCodePath = join(sandboxDir, 'agent.ts')
  const fullCode = `// ── Agent code ──
// Servers are available at: ${relative(sandboxDir, serversDir)}
// Use: import { callMCPTool } from './client.js';

${code}
`
  await writeFile(agentCodePath, fullCode)

  const workspaceFiles: string[] = []

  // Execute in sandbox
  try {
    const result = await spawnWithTimeoutBun(
      agentCodePath,
      sandboxDir,
      options?.timeoutMs || 300_000,
      options?.signal,
      options?.env,
    )

    // Collect any files written to workspace during execution
    try {
      const wsFiles = await readdir(workspaceDir)
      workspaceFiles.push(...wsFiles.map(f => join(workspaceDir, f)))
    } catch { /* workspace may not exist */ }

    // Cleanup sandbox
    try { await rm(sandboxDir, { recursive: true, force: true }) } catch { /* best effort */ }

    return { ...result, workspaceFiles }
  } catch (err) {
    try { await rm(sandboxDir, { recursive: true, force: true }) } catch { /* best effort */ }
    return {
      success: false,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      workspaceFiles,
    }
  }
}

function spawnWithTimeoutBun(
  scriptPath: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  extraEnv?: Record<string, string>,
): Promise<CodeExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', scriptPath], {
      cwd,
      env: {
        ...process.env as Record<string, string>,
        ...extraEnv,
        MCP_FS_SANDBOX: '1',
        MCP_FS_WORKSPACE: getWorkspaceDir(),
        MCP_FS_SKILLS: getSkillsDir(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000) }
      resolve({ success: false, stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1, workspaceFiles: [] })
    }, timeoutMs)

    if (signal) {
      signal.addEventListener('abort', () => {
        if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGTERM') }
        resolve({ success: false, stdout, stderr: stderr + '\n[ABORTED]', exitCode: -1, workspaceFiles: [] })
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    child.on('close', (code) => {
      if (!settled) {
        settled = true; clearTimeout(timer)
        resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, workspaceFiles: [] })
      }
    })
  })
}

// ── Tool Discovery + Generation ──────────────────────────────────

/**
 * Scan the servers directory and generate .ts tool files.
 * This combines discovery + code generation in one step.
 */
export async function discoverAndGenerate(): Promise<{
  entries: McpFsRegistryEntry[]
  filesWritten: string[]
}> {
  const entries = await discoverTools()
  const { filesWritten } = await generateToolFiles(entries)
  return { entries, filesWritten }
}

// ── In-process discovery cache ───────────────────────────────────
//
// discoverTools() was previously called on every goal continuation, on every
// mcp-fs tool description()/prompt() build, and on every executeToolSimple()
// invocation. Each call did readdir + per-server stat/readFile/jsonParse +
// an *unconditional* writeFile(registry.json). On a warm machine that's
// ~5-20ms per call. With ~10 goal continuations in a turn the waste adds up.
//
// This cache memoizes the entry list for `DISCOVER_TTL_MS` and skips the
// registry.json rewrite when the serialized payload hasn't changed. Cache
// is invalidated whenever a tool that mutates servers (mcpfs_discover with
// regenerate=true, discoverAndGenerate, generateToolFiles) runs.

const DISCOVER_TTL_MS = 15_000

interface DiscoverCacheEntry {
  entries: McpFsRegistryEntry[]
  fetchedAt: number
  probeMcpServers: boolean
}

let discoverCache: DiscoverCacheEntry | null = null
let lastRegistryJson: string | null = null
let baseDirCreated = false
let serversDirCreated = false

/**
 * Invalidate the in-process discovery cache. Called by mutating paths
 * (mcpfs_discover with regenerate=true, generateToolFiles, etc.) so the
 * next read sees the fresh state.
 */
export function invalidateDiscoverToolsCache(): void {
  discoverCache = null
  lastRegistryJson = null
}

/**
 * Cached wrapper around discoverTools(). Hot, read-only callers (goal
 * continuation prompt, tool description() / prompt() rendering, look-up
 * inside executeToolSimple) should prefer this over the raw scan.
 *
 * - opts.probeMcpServers is part of the cache key — separate caches for
 *   probe-enabled vs probe-disabled runs so one path can't poison the other.
 * - opts.ttlMs overrides DISCOVER_TTL_MS for callers that want fresher data.
 */
export async function discoverToolsCached(opts?: {
  probeMcpServers?: boolean
  ttlMs?: number
}): Promise<McpFsRegistryEntry[]> {
  const probe = opts?.probeMcpServers !== false
  const ttl = opts?.ttlMs ?? DISCOVER_TTL_MS
  const now = Date.now()

  if (
    discoverCache &&
    discoverCache.probeMcpServers === probe &&
    now - discoverCache.fetchedAt < ttl
  ) {
    return discoverCache.entries
  }

  const entries = await discoverTools({ probeMcpServers: probe })
  discoverCache = { entries, fetchedAt: now, probeMcpServers: probe }
  return entries
}

/**
 * Scan for manifest.json files in the servers directory.
 * Also supports individual .ts files (ls-style discovery).
 * Also auto-discovers traditional MCP servers from system configs.
 *
 * Hot callers should use {@link discoverToolsCached} instead of this raw scan.
 */
export async function discoverTools(opts?: {
  probeMcpServers?: boolean
}): Promise<McpFsRegistryEntry[]> {
  const serversDir = getServersDir()
  if (!serversDirCreated) {
    if (!existsSync(serversDir)) {
      await mkdir(serversDir, { recursive: true })
    }
    serversDirCreated = true
  }

  const entries: McpFsRegistryEntry[] = []
  let serverDirs: string[]
  try { serverDirs = await readdir(serversDir) } catch { serverDirs = [] }

  for (const serverName of serverDirs) {
    const serverDir = join(serversDir, serverName)
    if (!(await isDirectory(serverDir))) continue

    // Primary: manifest.json
    const manifestPath = join(serverDir, 'manifest.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = jsonParse(await readFile(manifestPath, 'utf-8')) as McpFsManifest
        for (const tool of manifest.tools) {
          entries.push({
            server: manifest.server || serverName,
            toolName: tool.name,
            description: tool.description,
            tsFilePath: join(serverDir, `${tool.name}.ts`),
            command: tool.command,
            mcpServer: tool.mcpServer,
            mcpToolName: tool.mcpToolName,
            inputSchema: tool.inputSchema,
            readOnly: tool.readOnly ?? false,
            destructive: tool.destructive ?? false,
          })
        }
      } catch { /* skip broken manifests */ }
    }

    // Secondary: individual .ts files (Anthropic-style ls discovery)
    try {
      const files = await readdir(serverDir)
      for (const file of files) {
        if (!file.endsWith('.ts') || file === 'index.ts') continue
        const alreadyInManifest = entries.some(
          e => e.server === serverName && e.toolName === file.replace('.ts', ''),
        )
        if (!alreadyInManifest) {
          entries.push({
            server: serverName,
            toolName: file.replace('.ts', ''),
            description: `Tool: ${file.replace('.ts', '')} (discovered via filesystem)`,
            tsFilePath: join(serverDir, file),
            readOnly: false,
            destructive: false,
          })
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  // ── Traditional MCP Server Bridge Discovery ──────────────────────
  // Scan .mcp.json / settings.json for configured MCP servers,
  // probe them for tools, and register bridge entries.
  const shouldProbe = opts?.probeMcpServers !== false
  if (shouldProbe) {
    try {
      const bridgeEntries = await discoverMcpBridgeTools()
      entries.push(...bridgeEntries)
    } catch { /* bridge discovery is best-effort */ }
  }

  // Persist registry — but only when the serialized payload actually changed.
  // Without this guard, every discoverTools() call wrote registry.json, which
  // is wasteful and creates spurious file-watcher events. The lastRegistryJson
  // module variable also short-circuits the rebuild-byte-compare for callers
  // hitting this multiple times per second.
  const serialized = jsonStringify(entries, 2)
  if (serialized !== lastRegistryJson) {
    if (!baseDirCreated) {
      await mkdir(getMcpFsBaseDir(), { recursive: true })
      baseDirCreated = true
    }
    try {
      await writeFile(
        join(getMcpFsBaseDir(), 'registry.json'),
        serialized,
      )
      lastRegistryJson = serialized
    } catch {
      // Registry persistence is best-effort; in-memory cache still valid.
    }
  }

  return entries
}

// ── Traditional MCP Bridge Discovery ────────────────────────────

interface McpServerConfigStub {
  type?: string
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

interface McpBridgeCache {
  scannedAt: number
  servers: Record<string, {
    config: McpServerConfigStub
    tools: Array<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
    }>
  }>
}

/**
 * Scan the system for traditional MCP server configurations.
 * Checks .mcp.json files, global settings, and known npm packages.
 */
async function getSystemMcpConfigs(): Promise<Record<string, McpServerConfigStub>> {
  const configs: Record<string, McpServerConfigStub> = {}

  // 1. Scan .mcp.json files in project tree
  try {
    const cwd = process.cwd()
    let dir = cwd
    while (true) {
      const mcpJsonPath = join(dir, '.mcp.json')
      if (existsSync(mcpJsonPath)) {
        try {
          const content = await readFile(mcpJsonPath, 'utf-8')
          const parsed = JSON.parse(content)
          if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
            for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
              if (!configs[name]) {
                configs[name] = cfg as McpServerConfigStub
              }
            }
          }
        } catch { /* skip broken files */ }
      }
      const parent = join(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  } catch { /* best effort */ }

  // 2. Global Claude Code settings
  try {
    const settingsPath = join(getClaudeConfigHomeDir(), 'settings.json')
    if (existsSync(settingsPath)) {
      const content = await readFile(settingsPath, 'utf-8')
      const parsed = JSON.parse(content)
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          if (!configs[name]) {
            configs[name] = cfg as McpServerConfigStub
          }
        }
      }
    }
  } catch { /* best effort */ }

  return configs
}

/**
 * Probe a traditional MCP server and list its tools.
 * Uses a lightweight Node.js subprocess to call the bridge script.
 */
async function probeMcpServerTools(
  serverName: string,
  config: McpServerConfigStub,
): Promise<McpBridgeCache['servers'][string]['tools']> {
  await ensureBridge()
  const bridgePath = getBridgePath()
  if (!existsSync(bridgePath)) return []

  const configJson = JSON.stringify(config).replace(/'/g, "'\\''")

  return new Promise((resolve) => {
    const child = spawn('node', [bridgePath], {
      env: {
        ...process.env as Record<string, string>,
        BRIDGE_SERVER_CONFIG: JSON.stringify(config),
        BRIDGE_TOOL: '', // empty = list tools mode
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    })

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', () => {}) // silence
    child.on('close', () => {
      try {
        const result = JSON.parse(stdout.trim() || '{}')
        if (result.tools && Array.isArray(result.tools)) {
          resolve(result.tools)
        } else if (result.error) {
          // Server not available — that's OK, skip
          resolve([])
        } else {
          resolve([])
        }
      } catch {
        resolve([])
      }
    })
    child.on('error', () => resolve([]))
  })
}

/**
 * Discover tools from traditional MCP servers and create bridge registry entries.
 * Caches results to avoid re-probing on every discovery cycle.
 */
async function discoverMcpBridgeTools(): Promise<McpFsRegistryEntry[]> {
  await ensureBridge()
  const cacheDir = join(getMcpFsBaseDir(), 'cache')
  await mkdir(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, 'mcp-bridge.json')

  const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

  // Try cache first
  let cache: McpBridgeCache | null = null
  try {
    if (existsSync(cachePath)) {
      cache = JSON.parse(await readFile(cachePath, 'utf-8'))
      if (Date.now() - cache.scannedAt > CACHE_TTL_MS) {
        cache = null // expired
      }
    }
  } catch { cache = null }

  // If cache is valid, use it
  if (cache) {
    return cacheToEntries(cache)
  }

  // Scan for MCP server configs
  const configs = await getSystemMcpConfigs()

  // Probe each server for tools (with concurrency limit)
  const serverEntries: McpBridgeCache['servers'] = {}
  const serverNames = Object.entries(configs)

  // Probe up to 3 servers concurrently to avoid thundering herd
  const CONCURRENCY = 3
  for (let i = 0; i < serverNames.length; i += CONCURRENCY) {
    const batch = serverNames.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(async ([name, cfg]) => {
        const tools = await probeMcpServerTools(name, cfg)
        return { name, cfg, tools }
      }),
    )
    for (const { name, cfg, tools } of results) {
      if (tools.length > 0) {
        serverEntries[name] = { config: cfg, tools }
      }
    }
  }

  // Write cache
  cache = { scannedAt: Date.now(), servers: serverEntries }
  try {
    await writeFile(cachePath, JSON.stringify(cache))
  } catch { /* best effort */ }

  return cacheToEntries(cache)
}

/**
 * Convert MCP bridge cache to MCP-FS registry entries.
 * Each traditional MCP tool gets a bridge wrapper entry.
 */
function cacheToEntries(cache: McpBridgeCache): McpFsRegistryEntry[] {
  const entries: McpFsRegistryEntry[] = []
  const bridgePath = getBridgePath()

  for (const [serverName, { config, tools }] of Object.entries(cache.servers)) {
    const safeServerName = serverName.replace(/[^a-zA-Z0-9_-]/g, '-')
    // Create pseudo-server directory for TS wrappers
    const serverDir = join(getServersDir(), `mcp-bridge-${safeServerName}`)

    for (const tool of tools) {
      const configJson = JSON.stringify(config)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "'\\''")

      entries.push({
        server: `mcp-bridge-${safeServerName}`,
        toolName: tool.name,
        description: tool.description || `MCP tool: ${serverName}/${tool.name}`,
        tsFilePath: join(serverDir, `${tool.name}.ts`),
        command: `BRIDGE_SERVER_CONFIG='${configJson}' BRIDGE_TOOL='${tool.name}' node "${bridgePath}"`,
        mcpServer: serverName,
        mcpToolName: tool.name,
        inputSchema: tool.inputSchema,
        readOnly: false,  // Unknown — assume mutable
        destructive: false, // Unknown — assume safe
      })
    }
  }

  return entries
}

// ── Simple execution (subprocess, for mcpfs tool) ────────────────

export async function executeToolSimple(
  toolName: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CodeExecResult> {
  // Use the cached registry for the lookup step — a 15s stale window is fine
  // because the only failure mode of staleness is "tool not found", which the
  // user can fix with mcpfs_discover regenerate=true (which invalidates).
  const entries = await discoverToolsCached()
  const entry = entries.find(
    e => `${e.server}/${e.toolName}` === toolName || e.toolName === toolName,
  )

  if (!entry) {
    return {
      success: false,
      stdout: '',
      stderr: `Tool not found: ${toolName}. Available: ${entries.map(e => `${e.server}/${e.toolName}`).join(', ')}`,
      exitCode: 127,
      workspaceFiles: [],
    }
  }

  // If the tool has a command, execute it directly
  if (entry.command) {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    // Pass args as JSON to preserve camelCase parameter names
    env['MCP_ARGS'] = jsonStringify(args)

    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', entry.command!], {
        cwd: join(getServersDir(), entry.server),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: options?.timeoutMs || 300_000,
      })

      let stdout = '', stderr = ''

      if (options?.signal) {
        options.signal.addEventListener('abort', () => child.kill('SIGTERM'))
      }

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('close', (code) => {
        resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? -1, workspaceFiles: [] })
      })
      child.on('error', (err) => {
        resolve({ success: false, stdout: '', stderr: err.message, exitCode: -1, workspaceFiles: [] })
      })
    })
  }

  // No command — use code execution
  const funcName = toCamelCase(entry.toolName)
  const code = `
import { ${funcName} } from './servers/${entry.server}/${entry.toolName}.js';
const result = await ${funcName}(${jsonStringify(args)});
console.log(JSON.stringify(result));
`
  return executeCode(code, options)
}

// ── Helpers ──────────────────────────────────────────────────────

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await import('fs/promises').then(m => m.stat(path))
    return stat.isDirectory()
  } catch {
    return false
  }
}

function toCamelCase(name: string): string {
  return name.replace(/[-_]([a-z])/g, (_, c) => (c as string).toUpperCase())
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function extractInputFields(schema?: Record<string, unknown>): Array<{ name: string; type: string; optional: boolean }> {
  if (!schema || !schema.properties) return []
  const props = schema.properties as Record<string, Record<string, unknown>>
  const required = (schema.required as string[]) || []
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: jsonSchemaToTs(def),
    optional: !required.includes(name),
  }))
}

function jsonSchemaToTs(schema: Record<string, unknown>): string {
  const type = schema.type as string
  switch (type) {
    case 'string': return 'string'
    case 'number':
    case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'unknown[]'
    case 'object': return 'Record<string, unknown>'
    default: return 'unknown'
  }
}

/**
 * Scaffold an example MCP filesystem server with demo tools.
 */
export async function scaffoldExampleServer(): Promise<string> {
  const serversDir = getServersDir()
  const exampleDir = join(serversDir, 'example-tools')
  await mkdir(exampleDir, { recursive: true })

  const manifest: McpFsManifest = {
    server: 'example-tools',
    version: '1.0.0',
    description: 'Example MCP filesystem tools',
    tools: [
      {
        name: 'echo',
        description: 'Echo back the input message',
        command: 'echo "{\\"message\\": \\"$MCP_ARG_MESSAGE\\"}"',
        readOnly: true,
      },
      {
        name: 'listFiles',
        description: 'List files in a directory',
        command: 'ls -la "${MCP_ARG_DIR:-.}"',
        readOnly: true,
      },
      {
        name: 'writeNote',
        description: 'Write a note to a file in the workspace',
        command: 'mkdir -p ./notes && echo "$MCP_ARG_CONTENT" > "./notes/$MCP_ARG_FILENAME" && echo "{\\"written\\": \\"./notes/$MCP_ARG_FILENAME\\"}"',
        destructive: true,
      },
    ],
  }

  await writeFile(join(exampleDir, 'manifest.json'), jsonStringify(manifest, 2))

  // Also generate .ts wrapper files
  const entries: McpFsRegistryEntry[] = manifest.tools.map(t => ({
    server: 'example-tools',
    toolName: t.name,
    description: t.description,
    tsFilePath: join(exampleDir, `${t.name}.ts`),
    command: t.command,
    inputSchema: t.inputSchema,
    readOnly: t.readOnly ?? false,
    destructive: t.destructive ?? false,
  }))
  await generateToolFiles(entries)

  return exampleDir
}
