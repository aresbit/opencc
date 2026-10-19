import type { TCPSocketListener } from 'bun'
import { randomBytes, timingSafeEqual } from 'crypto'
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getDenyRuleForTool,
  toolAlwaysAllowedRule,
} from '../../utils/permissions/permissions.js'
import {
  callMCPToolWithUrlElicitationRetry,
  ensureConnectedClient,
  getMcpToolTimeoutMs,
} from '../mcp/client.js'
import { buildMcpToolName } from '../mcp/mcpStringUtils.js'
import type { ConnectedMCPServer, MCPServerConnection } from '../mcp/types.js'
import { getMcpFsProjector, type ProjectionIndex } from './projection.js'

/**
 * The host side of mcp-fs: sandbox code calls MCP tools through here.
 *
 * One loopback listener per process; one session per CodeAct run, holding a
 * random token, the run's tool context and what the run was approved to call.
 * A request is one JSON line, the reply one JSON line, then the connection
 * closes — trivial to speak from any language's standard library.
 *
 * Every call goes to the connection opencc already holds: same auth, same
 * server process, same server-side state as the model's own MCP tool calls.
 */

export type McpRef = { server: string; tool: string }

/** What a run is allowed to call beyond read-only tools. */
export type McpApproval = {
  /** `server\u0000tool` */
  tools: Set<string>
  /** Servers imported wholesale (`import * as x`, `import servers.x`). */
  servers: Set<string>
}

export const refKey = (server: string, tool: string) => `${server}\u0000${tool}`

export type McpCallVerdict = {
  allow: boolean
  /** Why it is allowed. */
  why?: 'bypass' | 'read_only' | 'rule' | 'approved'
  /** Why it is not. */
  code?: 'denied' | 'not_approved'
  message?: string
}

const permissionTool = (server: string, tool: string) => ({
  name: buildMcpToolName(server, tool),
  mcpInfo: { serverName: server, toolName: tool },
})

export function isReadOnlyMcpTool(
  server: string,
  tool: string,
  index: ProjectionIndex = getMcpFsProjector().getIndex(),
): boolean {
  const entry = Object.values(index.servers).find(s => s.name === server)
  return entry?.tools.find(t => t.name === tool)?.readOnly === true
}

/**
 * The one decision both halves share: CodeAct's permission check asks it which
 * referenced tools still need approval, and the gateway asks it again for each
 * call at run time — so what was approved is exactly what can run.
 */
export function decideMcpCall(
  context: Pick<ToolUseContext, 'getAppState'>,
  ref: McpRef,
  approval: McpApproval | undefined,
  index?: ProjectionIndex,
): McpCallVerdict {
  const permissions = context.getAppState().toolPermissionContext
  const deny = getDenyRuleForTool(permissions, permissionTool(ref.server, ref.tool))
  if (deny) {
    return {
      allow: false,
      code: 'denied',
      message: `${ref.server}/${ref.tool} is denied by your permission rules (${deny.ruleValue.toolName}).`,
    }
  }
  if (
    permissions.mode === 'bypassPermissions' ||
    (permissions.mode === 'plan' && permissions.isBypassPermissionsModeAvailable)
  ) {
    return { allow: true, why: 'bypass' }
  }
  if (isReadOnlyMcpTool(ref.server, ref.tool, index)) return { allow: true, why: 'read_only' }
  if (toolAlwaysAllowedRule(permissions, permissionTool(ref.server, ref.tool))) {
    return { allow: true, why: 'rule' }
  }
  if (approval?.tools.has(refKey(ref.server, ref.tool)) || approval?.servers.has(ref.server)) {
    return { allow: true, why: 'approved' }
  }
  return {
    allow: false,
    code: 'not_approved',
    message:
      `${ref.server}/${ref.tool} is not read-only and was not approved for this run. ` +
      `Import it by name (e.g. from ./servers/<server>/index.ts) or call callMCPTool with literal names, ` +
      `so the run's approval can include it.`,
  }
}

type Session = {
  token: Buffer
  context: ToolUseContext
  approval: McpApproval
  controller: AbortController
}

type Reply = { ok: true; result: unknown } | { ok: false; error: string; code: string }

function connectedServer(context: ToolUseContext, name: string): MCPServerConnection | undefined {
  let clients: readonly MCPServerConnection[] = context.options.mcpClients ?? []
  try {
    clients = context.getAppState().mcp.clients
  } catch {
    // Fall back to the snapshot the tool call was made with.
  }
  return clients.find(client => client.name === name)
}

async function handle(session: Session, request: Record<string, unknown>): Promise<Reply> {
  const op = request.op
  const server = typeof request.server === 'string' ? request.server : ''
  const connection = connectedServer(session.context, server)
  if (!connection || connection.type !== 'connected') {
    const live = (session.context.getAppState().mcp.clients ?? [])
      .filter(client => client.type === 'connected')
      .map(client => client.name)
    return {
      ok: false,
      code: 'not_connected',
      error: `MCP server "${server}" is not connected (${connection?.type ?? 'unknown'}). Connected: ${live.join(', ') || 'none'}.`,
    }
  }
  const client = await ensureConnectedClient(connection as ConnectedMCPServer)
  const signal = session.controller.signal

  if (op === 'call') {
    const tool = typeof request.tool === 'string' ? request.tool : ''
    const verdict = decideMcpCall(session.context, { server, tool }, session.approval)
    if (!verdict.allow) return { ok: false, code: verdict.code ?? 'denied', error: verdict.message ?? 'refused' }
    const args =
      request.args && typeof request.args === 'object' ? (request.args as Record<string, unknown>) : {}
    const result = await callMCPToolWithUrlElicitationRetry({
      client,
      clientConnection: connection,
      tool,
      args,
      signal,
      setAppState: session.context.setAppState,
      handleElicitation: session.context.handleElicitation,
      // Raw result: the model-facing path truncates or swaps large output for
      // a file pointer, which is exactly what code calling a tool must not get.
      callToolFn: async ({ client: c, tool: name, args: input, meta, signal: s }) => {
        const raw = await c.client.callTool(
          { name, arguments: input, _meta: meta },
          CallToolResultSchema,
          { signal: s, timeout: getMcpToolTimeoutMs() },
        )
        return {
          content: raw.content as never,
          structuredContent: raw.structuredContent as Record<string, unknown> | undefined,
          _meta: raw._meta as Record<string, unknown> | undefined,
          isError: raw.isError === true,
        } as never
      },
    })
    return { ok: true, result }
  }
  if (op === 'read_resource' && typeof request.uri === 'string') {
    return {
      ok: true,
      result: await client.client.request(
        { method: 'resources/read', params: { uri: request.uri } },
        ReadResourceResultSchema,
        { signal },
      ),
    }
  }
  if (op === 'list_resources') {
    return {
      ok: true,
      result: await client.client.request({ method: 'resources/list', params: {} }, ListResourcesResultSchema, { signal }),
    }
  }
  if (op === 'get_prompt' && typeof request.name === 'string') {
    return {
      ok: true,
      result: await client.client.request(
        {
          method: 'prompts/get',
          params: { name: request.name, arguments: (request.args as Record<string, string>) ?? {} },
        },
        GetPromptResultSchema,
        { signal },
      ),
    }
  }
  return { ok: false, code: 'bad_request', error: `Unknown or incomplete request: ${String(op)}` }
}

class McpGateway {
  private readonly sessions = new Set<Session>()
  private listener: TCPSocketListener<{ buffer: string }> | undefined

  private start() {
    this.listener = Bun.listen<{ buffer: string }>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: socket => {
          socket.data = { buffer: '' }
        },
        data: (socket, chunk) => {
          socket.data.buffer += chunk.toString('utf8')
          const newline = socket.data.buffer.indexOf('\n')
          if (newline < 0) return
          const line = socket.data.buffer.slice(0, newline)
          socket.data.buffer = ''
          void this.respond(line).then(reply => {
            socket.write(`${JSON.stringify(reply)}\n`)
            socket.end()
          })
        },
      },
    })
    // Never what keeps the process alive.
    this.listener.unref?.()
  }

  private find(token: unknown): Session | undefined {
    if (typeof token !== 'string') return undefined
    const presented = Buffer.from(token)
    for (const session of this.sessions) {
      if (session.token.length === presented.length && timingSafeEqual(session.token, presented)) {
        return session
      }
    }
    return undefined
  }

  private async respond(line: string): Promise<Reply> {
    let request: Record<string, unknown>
    try {
      request = JSON.parse(line) as Record<string, unknown>
    } catch {
      return { ok: false, code: 'bad_request', error: 'Request is not JSON.' }
    }
    const session = this.find(request.token)
    if (!session) return { ok: false, code: 'unauthorized', error: 'Unknown or expired MCP gateway token.' }
    try {
      return await handle(session, request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`[mcp-fs] ${String(request.server)}/${String(request.tool ?? request.op)} failed: ${message}`)
      return { ok: false, code: session.controller.signal.aborted ? 'aborted' : 'error', error: message }
    }
  }

  /**
   * Open a session for one run. The returned environment goes to the sandbox;
   * `close` revokes the token and cancels anything still in flight.
   */
  open(context: ToolUseContext, approval: McpApproval, parentSignal?: AbortSignal) {
    if (!this.listener) this.start()
    const token = randomBytes(24).toString('hex')
    const session: Session = {
      token: Buffer.from(token),
      context,
      approval,
      controller: new AbortController(),
    }
    this.sessions.add(session)
    const close = () => {
      if (!this.sessions.delete(session)) return
      session.controller.abort()
      parentSignal?.removeEventListener('abort', close)
    }
    parentSignal?.addEventListener('abort', close, { once: true })
    return {
      environment: {
        OPENCC_MCP_GATEWAY: `127.0.0.1:${this.listener!.port}`,
        OPENCC_MCP_TOKEN: token,
      },
      close,
    }
  }
}

let gateway: McpGateway | undefined

export function getMcpGateway(): McpGateway {
  gateway ??= new McpGateway()
  return gateway
}
