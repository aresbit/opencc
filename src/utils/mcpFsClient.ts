/**
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
    MCP_TOOL_DIR: `./servers/${server}`,
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
        error: `Tool ${qualifiedName} has no command defined. Tool exists but cannot be executed directly.`,
        _meta: { server, toolName, qualifiedName },
      } as unknown as T;
    }
  } catch {
    return {
      error: `Tool registry not found. Run mcpfs_discover first.`,
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
