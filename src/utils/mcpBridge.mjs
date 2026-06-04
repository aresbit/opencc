#!/usr/bin/env node
/**
 * MCP-FS → Traditional MCP Server Bridge
 * ======================================
 * Connects to a traditional MCP server (stdio/http/sse), lists or calls
 * a tool, and outputs JSON to stdout. Designed to be used as the `command`
 * in MCP-FS registry entries for auto-discovered MCP servers.
 *
 * Usage (via env vars):
 *   BRIDGE_SERVER_CONFIG='{"type":"stdio","command":"npx","args":["-y","some-mcp-server"]}'
 *   MCP_ARG_TOOL=tool_name
 *   MCP_ARG_ARG1=value1  MCP_ARG_ARG2=value2  ...
 *   node bridge.mjs
 *
 * If MCP_ARG_TOOL is empty, lists all tools.
 */

import { spawn, execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

// ── JSON-RPC Helpers ──────────────────────────────────────────────

let _id = 1;
function nextId() { return _id++; }

function rpcRequest(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params });
}

// ── Stdio Transport ───────────────────────────────────────────────

function spawnStdioServer(command, args, env) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stderr.on('data', () => {}); // silence stderr
  return child;
}

function readRpcMessages(child, expectedId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const messages = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); resolve(messages); }
    }, timeoutMs);

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line.trim());
        messages.push(msg);
        // Only stop when we receive the response matching our expected request id
        if ('id' in msg && msg.id === expectedId && !('method' in msg)) {
          clearTimeout(timer);
          if (!settled) { settled = true; child.kill(); resolve(messages); }
        }
      } catch { /* skip non-JSON lines */ }
    });

    rl.on('close', () => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(messages); }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
  });
}

async function stdioCall(config, method, params) {
  const { command, args = [], env = {} } = config;
  const child = spawnStdioServer(command, args, env);

  // Send initialize first
  const initReq = rpcRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-fs-bridge', version: '1.0.0' },
  });

  child.stdin.write(initReq + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // Send the actual request
  const req = rpcRequest(method, params);
  const expectedId = _id - 1; // ID of the last request
  child.stdin.write(req + '\n');

  // Read responses
  const messages = await readRpcMessages(child, expectedId, 60000);

  // Find the response to our last request
  const response = messages.find(m => 'id' in m && m.id === _id - 1 && !('method' in m));
  if (response) {
    if (response.error) return { error: response.error };
    return response.result;
  }
  return { error: 'No response received', messages };
}

// ── HTTP/SSE Transport ─────────────────────────────────────────────

const SSE_HEADERS = {
  'Accept': 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};

/** Parse SSE text into JSON-RPC messages */
function parseSseFromText(text) {
  const messages = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { messages.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
    }
  }
  return messages;
}

/** Call an MCP server via HTTP POST using curl (respects proxy env vars).
 *  Stateless HTTP servers don't require initialize — each POST is self-contained. */
function httpCall(config, method, params) {
  const url = config.url.replace(/\/+$/, '');
  const headers = { ...SSE_HEADERS, ...(config.headers || {}) };

  const body = rpcRequest(method, params);
  const curlArgs = ['-s', '-X', 'POST', url, '-d', body];
  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }

  return new Promise((resolve) => {
    execFile('curl', curlArgs, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // curl exits non-zero on HTTP errors, but stdout still has the body
        if (!stdout.trim()) {
          resolve({ error: err.message });
          return;
        }
      }
      const text = stdout.trim();
      if (!text) { resolve({ error: 'Empty response' }); return; }

      // Try SSE parsing first
      if (text.includes('event: message') || text.includes('data: ')) {
        const messages = parseSseFromText(text);
        const response = messages.find(m => 'id' in m && !('method' in m));
        if (response) {
          if (response.error) { resolve({ error: response.error }); return; }
          resolve(response.result || response);
          return;
        }
        resolve({ error: 'No response in SSE stream', messages });
        return;
      }

      // Plain JSON
      try {
        const data = JSON.parse(text);
        if (data.error) { resolve({ error: data.error }); return; }
        resolve(data.result || data);
      } catch {
        resolve({ _raw: text });
      }
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const serverConfigStr = process.env.BRIDGE_SERVER_CONFIG;
  const toolName = process.env.BRIDGE_TOOL;

  if (!serverConfigStr) {
    console.log(JSON.stringify({ error: 'BRIDGE_SERVER_CONFIG is required' }));
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(serverConfigStr);
  } catch {
    console.log(JSON.stringify({ error: 'Invalid BRIDGE_SERVER_CONFIG JSON' }));
    process.exit(1);
  }

  const transportType = config.type || 'stdio';

  try {
    if (!toolName) {
      // List tools mode
      const result = transportType === 'http' || transportType === 'sse'
        ? await httpCall(config, 'tools/list', {})
        : await stdioCall(config, 'tools/list', {});
      console.log(JSON.stringify(result));
    } else {
      // Call tool mode — prefer MCP_ARGS JSON, fall back to MCP_ARG_* env vars
      let toolArgs = {};
      if (process.env.MCP_ARGS) {
        try { toolArgs = JSON.parse(process.env.MCP_ARGS); } catch { /* ignore */ }
      }
      // MCP_ARG_* vars override/extend MCP_ARGS
      for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('MCP_ARG_') &&
            key !== 'BRIDGE_SERVER_CONFIG' &&
            key !== 'MCP_ARG_TOOL' &&
            key !== 'MCP_ARG_TOOL_NAME' &&
            key !== 'MCP_ARGS') {
          // Preserve the arg name case by requiring the caller to use the exact
          // env var: MCP_ARG_repoName for parameter "repoName". We strip the
          // prefix only, preserving the rest of the key's case.
          const argName = key.slice('MCP_ARG_'.length);
          try { toolArgs[argName] = JSON.parse(value); } catch { toolArgs[argName] = value; }
        }
      }

      const callParams = { name: toolName, arguments: toolArgs };
      const result = transportType === 'http' || transportType === 'sse'
        ? await httpCall(config, 'tools/call', callParams)
        : await stdioCall(config, 'tools/call', callParams);
      console.log(JSON.stringify(result));
    }
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
