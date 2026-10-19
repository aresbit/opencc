import type { McpRef } from './gateway.js'
import type { ProjectedServer, ProjectionIndex } from './projection.js'

/**
 * Which MCP tools a piece of CodeAct code can reach, read from its source.
 *
 * The approval a run gets is computed from this, and the gateway enforces it,
 * so the scan only has to be conservative in one direction: anything it cannot
 * see (a tool name built at run time) is simply not approved, and the gateway
 * refuses it with a message saying to import it by name.
 *
 * Recognised (TypeScript):
 *   import { a, b as c } from './servers/<server>' | '.../<server>/index.ts'
 *   import { a } from './servers/<server>/<tool>.ts'
 *   import * as ns from './servers/<server>/index.ts'     → whole server
 *   callMCPTool('<server>', '<tool>' …)
 * Recognised (Python):
 *   from servers.<server> import a, b                     (* → whole server)
 *   from servers.<server>.<tool> import <tool>
 *   import servers.<server>  |  from servers import <server>  → whole server
 *   call_tool("<server>", "<tool>" …)
 */

export type McpScan = {
  refs: McpRef[]
  /** Original server names imported wholesale. */
  servers: string[]
}

function byIdent(index: ProjectionIndex, ident: string): ProjectedServer | undefined {
  return (
    index.servers[ident] ??
    Object.values(index.servers).find(server => server.ident === ident || server.name === ident)
  )
}

export function scanMcpReferences(code: string, index: ProjectionIndex): McpScan {
  const refs = new Map<string, McpRef>()
  const servers = new Set<string>()
  const add = (server: ProjectedServer | undefined, symbol: string) => {
    if (!server) return
    const tool = server.tools.find(t => t.fn === symbol || t.ident === symbol || t.name === symbol)
    if (tool) refs.set(`${server.name}\u0000${tool.name}`, { server: server.name, tool: tool.name })
  }
  const named = (list: string) =>
    list
      .replace(/[()]/g, '')
      .split(',')
      .map(part => part.trim().split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean)

  // ── TypeScript / JavaScript ──
  const tsImport =
    /import\s+(?:type\s+)?(\*\s+as\s+\w+|\{[^}]*\}|\w+)\s+from\s+['"]([^'"]*servers\/([A-Za-z0-9_]+)(?:\/([A-Za-z0-9_]+))?(?:\.(?:ts|js|mjs))?)['"]/g
  for (const match of code.matchAll(tsImport)) {
    const [, clause, , serverIdent, file] = match
    const server = byIdent(index, serverIdent!)
    if (!server) continue
    if (file && file !== 'index') {
      add(server, file)
    } else if (clause!.startsWith('*')) {
      servers.add(server.name)
    } else if (clause!.startsWith('{')) {
      for (const symbol of named(clause!.slice(1, -1))) add(server, symbol)
    }
  }
  for (const match of code.matchAll(/callMCPTool\s*(?:<[^>]*>)?\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])([^'"`]+)\3/g)) {
    add(byIdent(index, match[2]!), match[4]!)
  }

  // ── Python ──
  for (const match of code.matchAll(/^\s*from\s+servers\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+import\b/gm)) {
    add(byIdent(index, match[1]!), match[2]!)
  }
  for (const match of code.matchAll(/^\s*from\s+servers\.([A-Za-z0-9_]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
    const server = byIdent(index, match[1]!)
    if (!server) continue
    if (match[2]!.trim() === '*') servers.add(server.name)
    else for (const symbol of named(match[2]!)) add(server, symbol)
  }
  for (const match of code.matchAll(/^\s*import\s+servers\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/gm)) {
    const server = byIdent(index, match[1]!)
    if (match[2]) add(server, match[2])
    else if (server) servers.add(server.name)
  }
  for (const match of code.matchAll(/^\s*from\s+servers\s+import\s+([^\n#]+)/gm)) {
    for (const symbol of named(match[1]!)) {
      const server = byIdent(index, symbol)
      if (server) servers.add(server.name)
    }
  }
  for (const match of code.matchAll(/call_tool\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]+)\3/g)) {
    add(byIdent(index, match[2]!), match[4]!)
  }

  return { refs: [...refs.values()], servers: [...servers] }
}
