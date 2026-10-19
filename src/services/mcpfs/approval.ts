import type { ToolUseContext } from '../../Tool.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  decideMcpCall,
  getMcpGateway,
  type McpApproval,
  type McpRef,
  refKey,
} from './gateway.js'
import { getMcpFsProjector, type ProjectionIndex } from './projection.js'
import { scanMcpReferences } from './scan.js'

/**
 * One-time approval for a CodeAct run, and the session that enforces it.
 *
 *   checkPermissions → mcpPermissionCheck(): which referenced tools still need
 *                      the user (not read-only, not covered by a rule)
 *   call             → openMcpRun(): the same references become the run's
 *                      approval; the gateway refuses anything outside it
 */

export const MCP_LANGUAGES = new Set(['typescript', 'python'])

/** Bring the tree up to date with the connections before reading it. */
export async function ensureMcpProjection(
  context: Pick<ToolUseContext, 'getAppState'>,
): Promise<ProjectionIndex> {
  const projector = getMcpFsProjector()
  if (isEnvDefinedFalsy(process.env.OPENCC_MCPFS)) return { version: 1, servers: {} }
  try {
    const { clients, tools } = context.getAppState().mcp
    await projector.sync(clients, tools)
  } catch {
    // A projection failure must not take CodeAct down; the index is what it is.
  }
  return projector.getIndex()
}

/** Every tool the code can reach, whole-server imports expanded. */
export function referencedMcpTools(
  code: string,
  index: ProjectionIndex,
): { refs: McpRef[]; approval: McpApproval } {
  const scan = scanMcpReferences(code, index)
  const refs = new Map(scan.refs.map(ref => [refKey(ref.server, ref.tool), ref]))
  for (const name of scan.servers) {
    const server = Object.values(index.servers).find(s => s.name === name)
    for (const tool of server?.tools ?? []) {
      refs.set(refKey(name, tool.name), { server: name, tool: tool.name })
    }
  }
  return {
    refs: [...refs.values()],
    approval: { tools: new Set(refs.keys()), servers: new Set(scan.servers) },
  }
}

export type McpPermissionCheck =
  | { kind: 'none' }
  | { kind: 'deny'; message: string }
  | { kind: 'ask'; pending: McpRef[]; message: string }

export async function mcpPermissionCheck(
  code: string | undefined,
  language: string | undefined,
  context: Pick<ToolUseContext, 'getAppState'>,
): Promise<McpPermissionCheck> {
  if (!code || !MCP_LANGUAGES.has(language ?? 'typescript')) return { kind: 'none' }
  const index = await ensureMcpProjection(context)
  if (Object.keys(index.servers).length === 0) return { kind: 'none' }
  const { refs } = referencedMcpTools(code, index)
  const pending: McpRef[] = []
  for (const ref of refs) {
    const verdict = decideMcpCall(context, ref, undefined, index)
    if (verdict.allow) continue
    if (verdict.code === 'denied') return { kind: 'deny', message: verdict.message ?? 'denied' }
    pending.push(ref)
  }
  if (pending.length === 0) return { kind: 'none' }
  const byServer = new Map<string, string[]>()
  for (const ref of pending) byServer.set(ref.server, [...(byServer.get(ref.server) ?? []), ref.tool])
  const lines = [...byServer].map(([server, tools]) => `  ${server}: ${tools.sort().join(', ')}`)
  return {
    kind: 'ask',
    pending,
    message:
      `This CodeAct run calls MCP tools that are not read-only:\n${lines.join('\n')}\n` +
      'Approving allows exactly these for this run; anything else it tries is refused.',
  }
}

/**
 * Open the gateway session for a run. Returns what the sandbox needs and a
 * `close` that revokes the session; a no-op when there is nothing to reach.
 */
export async function openMcpRun(
  code: string,
  language: string | undefined,
  context: ToolUseContext,
  signal?: AbortSignal,
): Promise<{ environment: Record<string, string>; serversDir?: string; close: () => void }> {
  if (!MCP_LANGUAGES.has(language ?? 'typescript')) return { environment: {}, close: () => {} }
  const index = await ensureMcpProjection(context)
  if (Object.keys(index.servers).length === 0) return { environment: {}, close: () => {} }
  const { approval } = referencedMcpTools(code, index)
  const session = getMcpGateway().open(context, approval, signal)
  return {
    environment: session.environment,
    serversDir: getMcpFsProjector().root,
    close: session.close,
  }
}
