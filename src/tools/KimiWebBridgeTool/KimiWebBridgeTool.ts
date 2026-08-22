import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { z } from 'zod/v4'
import {
  buildTool,
  type ToolDef,
  type ToolInputJSONSchema,
} from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { flattenUnionSchema } from '../MemoryTool/flattenSchema.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import {
  DAEMON_BIN,
  DAEMON_PORT,
  DAEMON_URL,
  EXTENSION_STORE_URL,
  INSTALL_SCRIPT_URL,
  KIMI_WEBBRIDGE_TOOL_NAME,
  MAX_RESULT_CHARS,
} from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

// ── Input schemas ─────────────────────────────────────────────────────
//
// Deliberately NOT z.strictObject: `session` is required on every browser
// command but meaningless on status/start/stop, so the model routinely carries
// it over onto a lifecycle call. Under strictObject that stray key fails the
// whole call with "Unrecognized key", and zod's discriminated-union error does
// not name the valid shape, so the model cannot recover. Plain z.object strips
// the extra key and runs the call the model meant to make. Same reasoning as
// MemoryTool's schemas.

const sessionField = z
  .string()
  .describe(
    'Session name — one task = one session = one tab group. Pick once per task and reuse on every command.',
  )

const installInput = z.object({
  action: z.literal('install'),
  version: z
    .string()
    .optional()
    .describe('Pin a specific version (e.g. v1.11.5); default latest'),
})

const statusInput = z.object({ action: z.literal('status') })
const startInput = z.object({ action: z.literal('start') })
const stopInput = z.object({ action: z.literal('stop') })
const restartInput = z.object({ action: z.literal('restart') })
const uninstallInput = z.object({ action: z.literal('uninstall') })
const upgradeInput = z.object({ action: z.literal('upgrade') })

const navigateInput = z.object({
  action: z.literal('navigate'),
  url: z.string().describe('URL to open'),
  newTab: z
    .boolean()
    .optional()
    .describe('Open a new tab (true) or send the current tab (false, default)'),
  group_title: z
    .string()
    .optional()
    .describe('Human-readable label for the tab group, set on the first navigate of a task'),
  session: sessionField,
})

const findTabInput = z.object({
  action: z.literal('find_tab'),
  url: z.string().describe('Full URL of the tab to re-select'),
  active: z
    .boolean()
    .optional()
    .describe('true borrows the tab the user is currently viewing'),
  session: sessionField,
})

const snapshotInput = z.object({
  action: z.literal('snapshot'),
  session: sessionField,
})

const clickInput = z.object({
  action: z.literal('click'),
  selector: z.string().describe('@e ref or CSS selector'),
  session: sessionField,
})

const fillInput = z.object({
  action: z.literal('fill'),
  selector: z.string().describe('@e ref or CSS selector'),
  value: z.string().describe('Text to insert (replaces existing content)'),
  session: sessionField,
})

const evaluateInput = z.object({
  action: z.literal('evaluate'),
  code: z.string().describe('JavaScript in the page realm; supports async/await'),
  session: sessionField,
})

const cdpInput = z.object({
  action: z.literal('cdp'),
  method: z.string().describe('CDP method name, e.g. Network.enable'),
  params: z.record(z.string(), z.unknown()).optional().describe('CDP params object'),
  session: sessionField,
})

const screenshotInput = z.object({
  action: z.literal('screenshot'),
  format: z.enum(['png', 'jpeg']).optional(),
  quality: z.number().int().min(0).max(100).optional(),
  selector: z.string().optional().describe('@e ref or CSS selector to capture a single element'),
  path: z.string().optional().describe('Output path; unique name recommended'),
  session: sessionField,
})

const networkInput = z.object({
  action: z.literal('network'),
  cmd: z.enum(['start', 'stop', 'list', 'detail']),
  filter: z.string().optional(),
  requestId: z.string().optional(),
  session: sessionField,
})

const uploadInput = z.object({
  action: z.literal('upload'),
  selector: z.string().describe('@e ref or CSS selector of the file input'),
  files: z.array(z.string()).min(1).describe('Local file paths to upload'),
  session: sessionField,
})

const saveAsPdfInput = z.object({
  action: z.literal('save_as_pdf'),
  paper_format: z.enum(['letter', 'a4', 'legal', 'a3', 'tabloid']).optional(),
  landscape: z.boolean().optional(),
  scale: z.number().min(0.1).max(2.0).optional(),
  print_background: z.boolean().optional(),
  path: z.string().optional().describe('Output path; unique name recommended'),
  session: sessionField,
})

const listTabsInput = z.object({
  action: z.literal('list_tabs'),
  session: sessionField,
})

const closeTabInput = z.object({
  action: z.literal('close_tab'),
  session: sessionField,
})

const closeSessionInput = z.object({
  action: z.literal('close_session'),
  session: sessionField,
})

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    installInput,
    statusInput,
    startInput,
    stopInput,
    restartInput,
    uninstallInput,
    upgradeInput,
    navigateInput,
    findTabInput,
    snapshotInput,
    clickInput,
    fillInput,
    evaluateInput,
    cdpInput,
    screenshotInput,
    networkInput,
    uploadInput,
    saveAsPdfInput,
    listTabsInput,
    closeTabInput,
    closeSessionInput,
  ]),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
type LifecycleAction = 'start' | 'stop' | 'restart' | 'uninstall' | 'upgrade'
type BrowserAction = Exclude<Input['action'], 'install' | 'status' | LifecycleAction>

// ── Output ────────────────────────────────────────────────────────────

type Output =
  | { action: 'install'; ok: boolean; message: string }
  | {
      action: 'status'
      running: boolean
      version: string
      extensionConnected: boolean
      extensionId: string
      extensionVersion: string
      port: number
      uptimeSeconds: number
      skills: unknown[]
      error?: string
    }
  | { action: LifecycleAction; ok: boolean; message: string }
  | { action: BrowserAction; data: Record<string, unknown> }

const READ_ONLY_ACTIONS = new Set<Input['action']>(['status', 'snapshot', 'list_tabs'])

/** Actions that change page, browser, or machine state. */
const DESTRUCTIVE_ACTIONS = new Set<Input['action']>([
  'navigate', 'click', 'fill', 'evaluate', 'cdp', 'upload',
  'close_tab', 'close_session',
  'install', 'uninstall', 'upgrade', 'stop', 'restart',
])

// ── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeout = 15000,
): Promise<Response> {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(id)
  }
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function runProcess(
  cmd: string,
  args: string[],
  timeoutMs = 60000,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Process timeout: ${cmd} ${args.join(' ')}`))
    }, timeoutMs)

    child.stdout.on('data', d => {
      stdout += d.toString()
    })
    child.stderr.on('data', d => {
      stderr += d.toString()
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

export type BridgeStatus = {
  running: boolean
  extensionConnected: boolean
  extensionId: string
  extensionVersion: string
}

/**
 * Read the daemon's status, or null when it is not reachable at all.
 *
 * The extension flag matters as much as the daemon flag: the daemon runs as a
 * background process and answers /status happily while the browser side is
 * detached, so "the daemon is up" says nothing about whether a command can
 * actually reach a tab.
 */
async function readStatus(): Promise<BridgeStatus | null> {
  try {
    const res = await fetchWithTimeout(`${DAEMON_URL}/status`, {}, 3000)
    if (!res.ok) return null
    const data = await parseJsonSafe(res)
    if (data === null || typeof data !== 'object') return null
    const s = data as Record<string, unknown>
    return {
      running: Boolean(s.running),
      extensionConnected: Boolean(s.extension_connected),
      extensionId: typeof s.extension_id === 'string' ? s.extension_id : '',
      extensionVersion: typeof s.extension_version === 'string' ? s.extension_version : '',
    }
  } catch {
    return null
  }
}

async function isDaemonRunning(): Promise<boolean> {
  return (await readStatus()) !== null
}

/**
 * What to tell the user when the browser side is not attached.
 *
 * The daemon says only "no extension connected", and the previous wording
 * turned that into "install the browser extension first" — a dead end for the
 * common case, which is that the extension is installed and the browser is
 * simply closed or the extension disabled. When the daemon still remembers an
 * extension id, we know it has been installed at some point and can say so.
 */
export function extensionNotConnectedMessage(status: BridgeStatus | null): string {
  const seenBefore = Boolean(status?.extensionId || status?.extensionVersion)
  if (seenBefore) {
    return (
      `kimi-webbridge 守护进程在运行，但浏览器扩展当前未连接` +
      `（守护进程记录的扩展 ${status?.extensionId}${status?.extensionVersion ? ` v${status.extensionVersion}` : ''}）。` +
      `扩展已安装过，所以通常是浏览器没有打开，或该扩展被停用/未获得当前窗口的权限。` +
      `请打开浏览器并确认扩展处于启用状态，然后重试；不要重新安装。`
    )
  }
  return (
    `kimi-webbridge 守护进程在运行，但没有浏览器扩展连接上来。` +
    `若尚未安装，请安装：${EXTENSION_STORE_URL}；` +
    `若已安装，请打开浏览器并确认扩展已启用。`
  )
}

/**
 * Ensure the daemon is up AND the browser extension is attached.
 *
 * Both halves are required for any browser command, so both are checked here.
 * Sending a command that cannot possibly reach a tab and then relaying the
 * daemon's terse refusal is how "no extension connected" ended up being
 * reported as a missing installation on a machine where the extension was
 * installed and connected.
 */
async function ensureBridgeReady(): Promise<void> {
  await ensureDaemon()
  const status = await readStatus()
  if (status && !status.extensionConnected) {
    throw new Error(extensionNotConnectedMessage(status))
  }
}

/** Start the daemon if it is not reachable. start is idempotent. */
async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunning()) return
  // The spawn itself must not propagate: when the binary is absent — the most
  // common first-run state — spawn emits ENOENT, and letting that reject here
  // surfaced a raw "spawn /home/.../kimi-webbridge ENOENT" while skipping the
  // message below that actually tells the caller how to install it.
  try {
    await runProcess(DAEMON_BIN, ['start'], 60000)
    await sleep(1000)
  } catch {
    // Fall through to the reachability check and its actionable error.
  }
  if (!(await isDaemonRunning())) {
    const hint = existsSync(DAEMON_BIN)
      ? `Check ${DAEMON_BIN}, or reinstall it: ${INSTALL_SCRIPT_URL}`
      : `The daemon is not installed (${DAEMON_BIN} does not exist). ` +
        `Run this tool with action="install" first.`
    throw new Error(
      `kimi-webbridge daemon is not running and could not be started. ${hint}`,
    )
  }
}

function decorateError(message: string): string {
  // The daemon reports this whenever the browser side is detached, which is
  // usually a closed browser rather than a missing install — see
  // extensionNotConnectedMessage.
  if (/no extension connected/i.test(message)) {
    return extensionNotConnectedMessage(null)
  }
  if (/update the Kimi WebBridge extension/i.test(message)) {
    return (
      `kimi-webbridge: ${message} — tell the user to update the extension in ` +
      `their browser and retry; do not reconcile versions yourself.`
    )
  }
  return `kimi-webbridge: ${message}`
}

/** POST one browser command to the daemon and return its `data` payload. */
async function sendDaemonCommand(
  action: BrowserAction,
  args: Record<string, unknown>,
  session: string,
): Promise<Record<string, unknown>> {
  await ensureBridgeReady()
  const res = await fetchWithTimeout(
    `${DAEMON_URL}/command`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args, session }),
    },
    120000,
  )
  const data = await parseJsonSafe(res)
  if (data === null || typeof data !== 'object') {
    throw new Error(`kimi-webbridge daemon returned non-JSON (HTTP ${res.status})`)
  }
  const payload = data as Record<string, unknown>
  if (payload.ok === false || payload.error) {
    const err = (payload.error ?? payload) as { message?: string } & Record<string, unknown>
    throw new Error(decorateError(String(err.message ?? JSON.stringify(err))))
  }
  // An HTTP error whose body carries neither `ok:false` nor `error` used to
  // fall through as success and hand the model an empty `{}`, i.e. a failed
  // command reported as a completed one.
  if (!res.ok) {
    throw new Error(
      decorateError(`daemon returned HTTP ${res.status}: ${truncate(JSON.stringify(payload), 500)}`),
    )
  }
  return (payload.data ?? {}) as Record<string, unknown>
}

async function runDaemonLifecycle(
  cmd: LifecycleAction,
): Promise<{ ok: boolean; message: string }> {
  const res = await runProcess(DAEMON_BIN, [cmd], 120000)
  const output = `${res.stdout}${res.stderr}`.trim()
  if (res.code !== 0) {
    return { ok: false, message: output || `${cmd} failed (exit ${res.code})` }
  }
  return { ok: true, message: output || `kimi-webbridge ${cmd}` }
}

async function installDaemon(version?: string): Promise<{ ok: boolean; message: string }> {
  if (existsSync(DAEMON_BIN)) {
    const res = await runProcess(DAEMON_BIN, ['upgrade'], 180000)
    const output = `${res.stdout}${res.stderr}`.trim()
    return res.code === 0
      ? { ok: true, message: output || 'already installed; aligned to latest release' }
      : { ok: false, message: output || `upgrade failed (exit ${res.code})` }
  }

  // The installer is downloaded and then executed, so where it lands matters.
  // A predictable path in the world-writable temp dir
  // (kimi-webbridge-install-<unix-seconds>.sh) is guessable: another local user
  // can pre-create it as a symlink — writeFileSync follows symlinks, so the
  // write lands on the link target — or swap its contents between the write and
  // the `bash` call and get their code run as this user. mkdtempSync creates a
  // fresh 0700 directory with a random suffix, which closes both.
  const dir = mkdtempSync(join(tmpdir(), 'kimi-webbridge-install-'))
  const tmp = join(dir, 'install.sh')
  try {
    const dl = await fetchWithTimeout(INSTALL_SCRIPT_URL, {}, 30000)
    if (!dl.ok) {
      throw new Error(`failed to download installer: HTTP ${dl.status}`)
    }
    writeFileSync(tmp, await dl.text(), { encoding: 'utf-8', mode: 0o600 })
    const env = { ...process.env, ...(version ? { KIMI_WEBBRIDGE_VERSION: version } : {}) }
    const res = await runProcess('bash', [tmp], 300000, env)
    const output = `${res.stdout}${res.stderr}`.trim()
    return res.code === 0
      ? { ok: true, message: output || 'kimi-webbridge installed' }
      : { ok: false, message: output || `installer failed (exit ${res.code})` }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

async function getStatusData(): Promise<Record<string, unknown>> {
  try {
    const res = await fetchWithTimeout(`${DAEMON_URL}/status`, {}, 5000)
    if (!res.ok) {
      throw new Error(`daemon returned HTTP ${res.status}`)
    }
    const data = await parseJsonSafe(res)
    if (data !== null && typeof data === 'object') return data as Record<string, unknown>
    throw new Error(`unexpected response HTTP ${res.status}`)
  } catch (error) {
    return {
      running: false,
      version: '',
      extension_connected: false,
      extension_id: '',
      extension_version: '',
      port: 0,
      uptime_seconds: 0,
      skills: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function truncate(text: string, max = MAX_RESULT_CHARS): string {
  return text.length <= max ? text : text.slice(0, max) + '\n…(truncated)'
}

function pretty(data: unknown): string {
  return truncate(JSON.stringify(data, null, 2))
}

// ── Tool ──────────────────────────────────────────────────────────────

export const KimiWebBridgeTool = buildTool({
  name: KIMI_WEBBRIDGE_TOOL_NAME,
  aliases: ['KimiWebBridgeTool'],
  searchHint: 'control the user real browser via a local kimi-webbridge daemon',
  shouldDefer: false,
  maxResultSizeChars: MAX_RESULT_CHARS,
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
    // io: 'input' so optional fields carrying a default are not advertised as
    // required.
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })

    // A discriminated union serializes to a top-level `oneOf` with no
    // `properties`. Anthropic renders that verbatim, but third-party endpoints
    // behind ANTHROPIC_BASE_URL usually route through an OpenAI-shaped
    // function-call API that reads `parameters.properties`, finds none, and
    // advertises a zero-argument tool — after which every call the model makes
    // is malformed. Send those a flattened object instead; runtime validation
    // is unchanged either way. Same fix as MemoryTool.
    if (!isFirstPartyAnthropicBaseUrl()) {
      return flattenUnionSchema(schema, 'action') as ToolInputJSONSchema
    }

    schema.type = 'object'
    return schema as ToolInputJSONSchema
  },
  userFacingName() {
    return 'KimiWebBridge'
  },
  isReadOnly(input: Input) {
    return READ_ONLY_ACTIONS.has(input.action)
  },
  isConcurrencySafe(input: Input) {
    return READ_ONLY_ACTIONS.has(input.action)
  },
  isDestructive(input: Input) {
    return DESTRUCTIVE_ACTIONS.has(input.action)
  },
  async checkPermissions() {
    // This is a local, owner-operated bridge. Browser and lifecycle actions
    // are intentionally auto-allowed so high-frequency automation never
    // pauses for a per-use confirmation dialog.
    return { behavior: 'allow' }
  },
  toAutoClassifierInput(input: Input) {
    return `kimi_webbridge:${input.action}`
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (!input.action) return null
    if (input.action === 'navigate') {
      return `kimi_webbridge navigate ${input.url ?? ''}`.trim()
    }
    return `kimi_webbridge ${input.action}`
  },
  async call(input: Input): Promise<{ data: Output }> {
    switch (input.action) {
      case 'install': {
        const r = await installDaemon(input.version)
        return { data: { action: 'install', ...r } }
      }
      case 'status': {
        const s = await getStatusData()
        return {
          data: {
            action: 'status',
            running: Boolean(s.running),
            version: String(s.version ?? ''),
            extensionConnected: Boolean(s.extension_connected),
            extensionId: String(s.extension_id ?? ''),
            extensionVersion: String(s.extension_version ?? ''),
            port: Number(s.port ?? DAEMON_PORT),
            uptimeSeconds: Number(s.uptime_seconds ?? 0),
            skills: Array.isArray(s.skills) ? s.skills : [],
            error: typeof s.error === 'string' ? s.error : undefined,
          },
        }
      }
      case 'start':
      case 'stop':
      case 'restart':
      case 'uninstall':
      case 'upgrade': {
        const r = await runDaemonLifecycle(input.action)
        return { data: { action: input.action, ...r } }
      }
      case 'navigate':
        return {
          data: {
            action: 'navigate',
            data: await sendDaemonCommand(
              'navigate',
              { url: input.url, newTab: input.newTab, group_title: input.group_title },
              input.session,
            ),
          },
        }
      case 'find_tab':
        return {
          data: {
            action: 'find_tab',
            data: await sendDaemonCommand(
              'find_tab',
              { url: input.url, active: input.active },
              input.session,
            ),
          },
        }
      case 'snapshot':
        return {
          data: {
            action: 'snapshot',
            data: await sendDaemonCommand('snapshot', {}, input.session),
          },
        }
      case 'click':
        return {
          data: {
            action: 'click',
            data: await sendDaemonCommand('click', { selector: input.selector }, input.session),
          },
        }
      case 'fill':
        return {
          data: {
            action: 'fill',
            data: await sendDaemonCommand(
              'fill',
              { selector: input.selector, value: input.value },
              input.session,
            ),
          },
        }
      case 'evaluate':
        return {
          data: {
            action: 'evaluate',
            data: await sendDaemonCommand('evaluate', { code: input.code }, input.session),
          },
        }
      case 'cdp':
        return {
          data: {
            action: 'cdp',
            data: await sendDaemonCommand(
              'cdp',
              { method: input.method, params: input.params },
              input.session,
            ),
          },
        }
      case 'screenshot':
        return {
          data: {
            action: 'screenshot',
            data: await sendDaemonCommand(
              'screenshot',
              {
                format: input.format,
                quality: input.quality,
                selector: input.selector,
                path: input.path,
              },
              input.session,
            ),
          },
        }
      case 'network':
        return {
          data: {
            action: 'network',
            data: await sendDaemonCommand(
              'network',
              { cmd: input.cmd, filter: input.filter, requestId: input.requestId },
              input.session,
            ),
          },
        }
      case 'upload':
        return {
          data: {
            action: 'upload',
            data: await sendDaemonCommand(
              'upload',
              { selector: input.selector, files: input.files },
              input.session,
            ),
          },
        }
      case 'save_as_pdf':
        return {
          data: {
            action: 'save_as_pdf',
            data: await sendDaemonCommand(
              'save_as_pdf',
              {
                paper_format: input.paper_format,
                landscape: input.landscape,
                scale: input.scale,
                print_background: input.print_background,
                path: input.path,
              },
              input.session,
            ),
          },
        }
      case 'list_tabs':
        return {
          data: {
            action: 'list_tabs',
            data: await sendDaemonCommand('list_tabs', {}, input.session),
          },
        }
      case 'close_tab':
        return {
          data: {
            action: 'close_tab',
            data: await sendDaemonCommand('close_tab', {}, input.session),
          },
        }
      case 'close_session':
        return {
          data: {
            action: 'close_session',
            data: await sendDaemonCommand('close_session', {}, input.session),
          },
        }
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const output = content as Output

    switch (output.action) {
      case 'install':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: output.ok ? `Installed kimi-webbridge: ${output.message}` : `Install failed: ${output.message}`,
        }
      case 'status':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: output.running
            ? `kimi-webbridge: running (v${output.version}, uptime ${output.uptimeSeconds}s), extension ` +
              (output.extensionConnected ? `connected (${output.extensionId})` : `NOT connected`)
            : `kimi-webbridge: not running${output.error ? ` — ${output.error}` : ''}`,
        }
      case 'start':
      case 'stop':
      case 'restart':
      case 'uninstall':
      case 'upgrade':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `${output.action}: ${output.message}`,
        }
      case 'snapshot':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Page: ${String(output.data.title ?? '')} (${String(output.data.url ?? '')})\n\n${truncate(JSON.stringify(output.data.tree ?? output.data))}`,
        }
      case 'screenshot':
      case 'save_as_pdf':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Saved to ${String(output.data.path ?? '?')} (${String(output.data.sizeBytes ?? '')} bytes) — open the path with the Read tool to see it.`,
        }
      case 'evaluate':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: truncate(String(output.data.value ?? pretty(output.data))),
        }
      case 'list_tabs': {
        const tabs = Array.isArray(output.data.tabs) ? output.data.tabs : []
        const lines = tabs.map((t: Record<string, unknown>) =>
          `- [${String(t.tabId ?? '')}] ${String(t.title ?? '')} ${String(t.url ?? '')}${t.active ? ' (active)' : ''}`,
        )
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: lines.length ? lines.join('\n') : 'No tabs in this session.',
        }
      }
      case 'navigate':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Navigated to ${String(output.data.url ?? '')} (tab ${String(output.data.tabId ?? '')})`,
        }
      default:
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: pretty(output.data),
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
