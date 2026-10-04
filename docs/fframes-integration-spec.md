# fframes integration spec — new built-in tool

Target repo: `/data/data/com.termux/files/home/opencc` (opencc, a decompiled Claude Code fork).
Runtime: Bun. Do NOT modify anything under `src/` while reading this spec; the builder
creates the files below. Every path is relative to the repo root.

Grounded sources (read these before implementing):
- `src/Tool.ts` — `buildTool`, `Tool`, `ToolDef`, `ToolResult`, `TOOL_DEFAULTS`.
- `src/tools/AwrOpsTool/AwrOpsTool.ts` — the bundled-knowledge tool template.
- `src/tools/AwrOpsTool/assets.ts` + `assets.d.ts` — in-repo asset pattern.
- `src/tools/RepoToSkillTool/runtime.ts` — the `runCommand()` subprocess helper.
- `src/services/functionHooks/types.ts`, `index.ts`, `matcher.ts`, `dispatcher.ts`,
  `plugins/index.ts`, `plugins/knowledgeHook.ts` — the hook (algebraic-effect) contract.
- `src/setup.ts` — engine initialization.

---

## 1. Tool contract summary

### 1.1 The `Tool` type (src/Tool.ts:362–695)

A tool is the object literal below. `ToolDef` (src/Tool.ts:721) is `Tool` with seven
methods optional; `buildTool` (src/Tool.ts:783) spreads `TOOL_DEFAULTS` under the def.
Required at runtime, with exact declared signatures:

| Field | Line | Signature / notes |
|---|---|---|
| `name` | 456 | `readonly name: string`. Stable, lowercase-kebab. |
| `aliases?` | 371 | `string[]` — extra lookup names. |
| `searchHint?` | 378 | `string` — 3–10 word ToolSearch phrase. |
| `call` | 379 | `(args: z.infer<Input>, context: ToolUseContext, canUseTool: CanUseToolFn, parentMessage: AssistantMessage, onProgress?: ToolCallProgress<P>) => Promise<ToolResult<Output>>`. MUST return `{ data: ... }` (ToolResult at 321). |
| `description` | 386 | `(input, options) => Promise<string>` |
| `inputSchema` | 394 | `readonly inputSchema: Input` (a Zod schema) |
| `inputJSONSchema?` | 397 | `ToolInputJSONSchema` (see 1.3; `type:'object'` required by API) |
| `outputSchema?` | 400 | `z.ZodType<unknown>`. Optional but define it; must match `data`. |
| `isConcurrencySafe` | 402 | `(input) => boolean` — default `false` (src/Tool.ts:759) |
| `isEnabled` | 403 | `() => boolean` — default `true` (src/Tool.ts:758) |
| `isReadOnly` | 404 | `(input) => boolean` — default `false` (src/Tool.ts:760) |
| `isDestructive?` | 406 | `(input) => boolean` — default `false` |
| `toAutoClassifierInput` | 556 | `(input) => unknown` — default `''` (src/Tool.ts:767) |
| `mapToolResultToToolResultBlockParam` | 557 | `(content: Output, toolUseID: string) => ToolResultBlockParam` — REQUIRED; serialize the human/model-facing text. |
| `userFacingName` | 524 | `(input) => string` — default `def.name` (src/Tool.ts:789) |
| `maxResultSizeChars` | 466 | `number` |
| `prompt` | 518 | `(options) => Promise<string>` — the model-facing instructions. |
| `validateInput?` | 489 | `(input, context) => Promise<ValidationResult>` |
| `checkPermissions` | 500 | `(input, context) => Promise<PermissionResult>` — default allow (src/Tool.ts:762) |
| `shouldDefer?` | 442 | Omit → tool loads immediately. `true` → needs ToolSearch first. |
| `alwaysLoad?` | 449 | `true` → never deferred. |
| `getActivityDescription?` | 546 | spinner text |
| `renderToolResultMessage?` / `renderToolUseMessage` | 566 / 605 | React/Ink renderers (omit for headless) |

`ToolResult<T>` (src/Tool.ts:321): `{ data: T; newMessages?; contextModifier?; mcpMeta? }`.
Returning a raw object instead of `{ data }` breaks the execution pipeline.

### 1.2 Defaults filled by `buildTool` (src/Tool.ts:748–769)

`isEnabled → true`, `isConcurrencySafe → false`, `isReadOnly → false`,
`isDestructive → false`, `checkPermissions → allow`, `toAutoClassifierInput → ''`,
`userFacingName → name`. Fail-closed: a tool is assumed writing + non-concurrent unless
it says otherwise.

### 1.3 `lazySchema` + `zodToJsonSchema` (real extensions are `.ts`, not `.js`)

- `src/utils/lazySchema.ts:5` — `lazySchema<T>(factory: () => T): () => T`; memoizes.
  Declare `const inputSchema = lazySchema(() => z.strictObject({...}))`, expose it as
  `get inputSchema() { return inputSchema() }`.
- `src/utils/zodToJsonSchema.ts:22` — `zodToJsonSchema(schema, {io})`. Cache-by-identity
  requires the SAME ZodTypeAny reference per session — only true if the schema comes
  from a `lazySchema` factory. `inputJSONSchema` must set `schema.type = 'object'`.
- Type aliases used by every tool: `type InputSchema = ReturnType<typeof inputSchema>`
  and `type Input = z.infer<InputSchema>` (see AwrOpsTool.ts:73–74).

### 1.4 Bundled-asset pattern (AwrOpsTool.ts + assets.ts)

- `assets.ts:16` imports each doc/script with Bun's text loader:
  `import skillMd from './assets/SKILL.md' with { type: 'text' }`. The bundler inlines
  the file contents as a string constant, so the tool ships with zero external deps.
- Namespaces: `GUIDE`/`GUIDE_PATH` (exports), `REFERENCES: ReferenceAsset[]` with
  `{name, path, content}`, `SCRIPTS: ScriptAsset[]` with
  `{name, path, language, suggestedFilename, content}`.
- `stripFrontmatter()` (assets.ts:61) strips a leading `---` block from docs; scripts are
  returned verbatim.
- Accessors: `getReference(name)` (145), `listReferences()` (150), `getScript(name)`
  (154), `listScripts()` (161).
- `action: guide|reference|script|list` is wired in `AwrOpsTool.ts:265–277` as a switch;
  each handler returns the `Output` shape and the tool wraps it with `{ data: ... }`.
- `assets.d.ts:1–13` supplies ambient `declare module '*.md'|'*.py'|'*.yaml'`. Bun
  resolves these at runtime; tsc errors here are pre-existing and non-blocking.

### 1.5 `runCommand` subprocess helper (RepoToSkillTool/runtime.ts:53)

```ts
export interface CommandResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
export async function runCommand(
  command: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<CommandResult>
```
Uses `Bun.spawn` with piped stdout/stderr, an `AbortController` timer
(`DEFAULT_COMMAND_TIMEOUT_MS = 120_000` at runtime.ts:7), drains both streams, and
returns a non-zero exit as DATA (never throws). Copy this file verbatim for FFramesTool.

### 1.6 Registration in `src/tools.ts`

- `src/tools.ts:1` is `// biome-ignore-all assist/source/organizeImports` — do not let an
  import sorter reorder this file.
- Imports are one per tool: `import { AwrOpsTool } from './tools/AwrOpsTool/AwrOpsTool.js'`
  (src/tools.ts:44). Neighbouring imports end at `Prove2MeTool` (src/tools.ts:51), then the
  `jitSynthesis` import (52).
- `getAllBaseTools()` (src/tools.ts:243) returns the array; `AwrOpsTool` (295),
  `AwrStRunTool` (296), `EvalApplyTool` (301). Ordering is NOT semantic for tool
  availability (all are loaded), so append near its siblings for readability.

---

## 2. File-by-file skeleton for `src/tools/FFramesTool/`

Create these five files plus the asset files. All imports use `.js` specifiers (ESM).

### 2.1 `src/tools/FFramesTool/prompt.ts`

```ts
export const FFRAMES_TOOL_NAME = 'fframes'

export const DESCRIPTION = `视频帧与渲染工具。内置 FFmpeg/FFprobe 参考文档与脚本，并可实际探测媒体元数据、抽取指定时间点的帧。所有文档内置于工具目录，无外部依赖。触发词："抽帧"、"生成缩略图"、"视频信息"、"ffmpeg"、"ffprobe"、"render frames"、"fframes"。`

export const PROMPT = `${DESCRIPTION}
- action="guide"     返回主指南正文。
- action="reference" 返回指定参考文档（reference=<name>）。
- action="script"    返回脚本源码（script=<name>），模型写入临时文件后可用 BashTool 执行。
- action="list"      列出全部参考文档与脚本。
- action="probe"     对 input 指向的媒体运行 ffprobe，返回时长与流信息（只读，需要系统已安装 ffprobe）。
- action="extract"   用 ffmpeg 抽帧到 outputDir（写盘）；timestamps 缺省为 ["0"]。

安全规则：extract 会写盘，仅在用户确认的目录内执行；不要用 sudo。`
```

### 2.2 `src/tools/FFramesTool/assets.d.ts`

```ts
declare module '*.md' {
  const content: string
  export default content
}
declare module '*.sh' {
  const content: string
  export default content
}
declare module '*.txt' {
  const content: string
  export default content
}
```

### 2.3 `src/tools/FFramesTool/assets.ts`

```ts
/**
 * Bundled asset registry for FFramesTool.
 * Every file under ./assets/ is inlined as a string constant via Bun's
 * `with { type: 'text' }` import attribute — zero runtime dependency on any
 * external path. To add an asset: drop the file under ./assets/ and add a
 * matching import + entry below.
 */
import fframesMd from './assets/FFRAMES.md' with { type: 'text' }
import ffmpegCheatsheet from './assets/references/ffmpeg-cheatsheet.md' with { type: 'text' }
import hdrTonemap from './assets/references/hdr-tonemap.md' with { type: 'text' }
import extractFramesSh from './assets/scripts/extract_frames.sh' with { type: 'text' }

export interface ReferenceAsset {
  name: string
  path: string
  content: string
}

export interface ScriptAsset {
  name: string
  path: string
  language: 'python' | 'bash' | 'text'
  suggestedFilename: string
  content: string
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4).replace(/^\r?\n/, '')
}

const REFERENCES: ReferenceAsset[] = [
  { name: 'ffmpeg-cheatsheet', path: 'assets/references/ffmpeg-cheatsheet.md', content: stripFrontmatter(ffmpegCheatsheet) },
  { name: 'hdr-tonemap', path: 'assets/references/hdr-tonemap.md', content: stripFrontmatter(hdrTonemap) },
]

const SCRIPTS: ScriptAsset[] = [
  { name: 'extract-frames', path: 'assets/scripts/extract_frames.sh', language: 'bash', suggestedFilename: 'extract_frames.sh', content: extractFramesSh },
]

export const GUIDE: string = stripFrontmatter(fframesMd)
export const GUIDE_PATH = 'assets/FFRAMES.md'

export function getReference(name: string): ReferenceAsset | undefined {
  const trimmed = name.trim().replace(/\.md$/i, '')
  return REFERENCES.find(r => r.name === trimmed)
}
export function listReferences(): ReadonlyArray<ReferenceAsset> { return REFERENCES }
export function getScript(name: string): ScriptAsset | undefined {
  const trimmed = name.trim()
  return SCRIPTS.find(s => s.name === trimmed || s.suggestedFilename === trimmed)
}
export function listScripts(): ReadonlyArray<ScriptAsset> { return SCRIPTS }
```

Asset files to create (content is prose/script; keep small but real):
- `src/tools/FFramesTool/assets/FFRAMES.md` — the guide body (may start with `---` frontmatter).
- `src/tools/FFramesTool/assets/references/ffmpeg-cheatsheet.md`
- `src/tools/FFramesTool/assets/references/hdr-tonemap.md`
- `src/tools/FFramesTool/assets/scripts/extract_frames.sh` — a `#!/usr/bin/env bash` + `set -euo pipefail` script.

### 2.4 `src/tools/FFramesTool/runtime.ts`

Copy `src/tools/RepoToSkillTool/runtime.ts:1–108` verbatim, dropping the RepoToSkill-only
helpers. Minimum surface:

```ts
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export async function fileExists(path: string): Promise<boolean> {
  const { access } = await import('fs/promises')
  const { constants } = await import('fs')
  return access(path, constants.F_OK).then(() => true, () => false)
}

export async function runCommand(
  command: string[],
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CommandResult> { /* copy RepoToSkillTool/runtime.ts:53–108 exactly */ }
```

### 2.5 `src/tools/FFramesTool/FFramesTool.ts`

```ts
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, FFRAMES_TOOL_NAME, PROMPT } from './prompt.js'
import {
  GUIDE, GUIDE_PATH, getReference, getScript, listReferences, listScripts,
  type ReferenceAsset, type ScriptAsset,
} from './assets.js'
import { runCommand, DEFAULT_COMMAND_TIMEOUT_MS } from './runtime.js'

const ACTION = z.enum(['guide', 'reference', 'script', 'list', 'probe', 'extract'])

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: ACTION.describe('guide|reference|script|list|probe|extract'),
    reference: z.string().optional().describe('reference 名（action="reference"）'),
    script: z.string().optional().describe('script 名（action="script"）'),
    input: z.string().optional().describe('媒体文件路径（action="probe"|"extract"）'),
    outputDir: z.string().optional().describe('抽帧输出目录（action="extract"，默认 /tmp/fframes）'),
    timestamps: z.array(z.string()).optional().describe('抽帧时间点，如 ["0","1.5","00:00:03"]（默认 ["0"]）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: ACTION,
    summary: z.string(),
    content: z.string().optional(),
    contentPath: z.string().optional(),
    bytes: z.number().int().optional(),
    language: z.enum(['python', 'bash', 'text']).optional(),
    suggestedFilename: z.string().optional(),
    availableReferences: z.array(z.object({ name: z.string(), bytes: z.number() })).optional(),
    availableScripts: z.array(z.object({
      name: z.string(), language: z.enum(['python', 'bash', 'text']),
      suggestedFilename: z.string(), bytes: z.number(),
    })).optional(),
    input: z.string().optional(),
    durationSeconds: z.number().optional(),
    streams: z.array(z.object({
      index: z.number(), codecType: z.string(), codecName: z.string(),
      width: z.number().optional(), height: z.number().optional(), fps: z.string().optional(),
    })).optional(),
    frames: z.array(z.object({ timestamp: z.string(), path: z.string() })).optional(),
    outputDir: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<typeof outputSchema>

const refSummary = (r: ReferenceAsset) => ({ name: r.name, bytes: Buffer.byteLength(r.content, 'utf-8') })
const scriptSummary = (s: ScriptAsset) => ({
  name: s.name, language: s.language, suggestedFilename: s.suggestedFilename,
  bytes: Buffer.byteLength(s.content, 'utf-8'),
})

function runGuide(): Output {
  return { success: true, action: 'guide', summary: 'Loaded FFrames guide.', content: GUIDE, contentPath: GUIDE_PATH, bytes: Buffer.byteLength(GUIDE, 'utf-8') }
}
function runReference(name: string | undefined): Output {
  if (!name?.trim()) return { success: false, action: 'reference', summary: 'reference 参数缺失。', availableReferences: listReferences().map(refSummary) }
  const ref = getReference(name)
  if (!ref) return { success: false, action: 'reference', summary: `未知 reference "${name}"。`, availableReferences: listReferences().map(refSummary) }
  return { success: true, action: 'reference', summary: `Loaded reference "${ref.name}".`, content: ref.content, contentPath: ref.path, bytes: Buffer.byteLength(ref.content, 'utf-8') }
}
function runScript(name: string | undefined): Output {
  if (!name?.trim()) return { success: false, action: 'script', summary: 'script 参数缺失。', availableScripts: listScripts().map(scriptSummary) }
  const s = getScript(name)
  if (!s) return { success: false, action: 'script', summary: `未知 script "${name}"。`, availableScripts: listScripts().map(scriptSummary) }
  return { success: true, action: 'script', summary: `Loaded script "${s.name}" (${s.language}). 写入 /tmp/${s.suggestedFilename} 后用 BashTool 执行。`, content: s.content, contentPath: s.path, bytes: Buffer.byteLength(s.content, 'utf-8'), language: s.language, suggestedFilename: s.suggestedFilename }
}
function runList(): Output {
  return { success: true, action: 'list', summary: `fframes assets: ${listReferences().length} references, ${listScripts().length} scripts.`, availableReferences: listReferences().map(refSummary), availableScripts: listScripts().map(scriptSummary) }
}
async function runProbe(input: string | undefined): Promise<Output> {
  if (!input?.trim()) return { success: false, action: 'probe', summary: 'probe 需要 input 路径。' }
  const r = await runCommand(['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { timeoutMs: 30_000 })
  if (r.exitCode !== 0) return { success: false, action: 'probe', input, summary: `ffprobe 失败 (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 400)}` }
  let parsed: any
  try { parsed = JSON.parse(r.stdout) } catch { return { success: false, action: 'probe', input, summary: 'ffprobe 输出不是合法 JSON。' } }
  const streams = (parsed.streams ?? []).map((s: any) => ({
    index: s.index, codecType: s.codec_type, codecName: s.codec_name,
    width: s.width, height: s.height, fps: s.r_frame_rate,
  }))
  const duration = parsed.format?.duration ? Number(parsed.format.duration) : undefined
  return { success: true, action: 'probe', input, summary: `Probed ${input}: ${streams.length} streams, ${duration ?? '?'}s.`, durationSeconds: Number.isFinite(duration) ? duration : undefined, streams }
}
async function runExtract(input: string | undefined, outputDir: string | undefined, timestamps: string[] | undefined): Promise<Output> {
  if (!input?.trim()) return { success: false, action: 'extract', summary: 'extract 需要 input 路径。' }
  const dir = outputDir?.trim() || '/tmp/fframes'
  const times = timestamps?.length ? timestamps : ['0']
  const { mkdir } = await import('fs/promises')
  await mkdir(dir, { recursive: true })
  const frames: Array<{ timestamp: string; path: string }> = []
  for (const t of times) {
    const out = `${dir}/frame_${String(t).replace(/[^0-9A-Za-z._-]/g, '-')}.png`
    const r = await runCommand(['ffmpeg', '-hide_banner', '-nostdin', '-y', '-ss', t, '-i', input, '-frames:v', '1', out], { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS })
    if (r.exitCode !== 0) return { success: false, action: 'extract', input, outputDir: dir, summary: `ffmpeg 在 t=${t} 失败 (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 400)}`, frames }
    frames.push({ timestamp: t, path: out })
  }
  return { success: true, action: 'extract', input, outputDir: dir, summary: `抽取 ${frames.length} 帧到 ${dir}。`, frames }
}

export const FFramesTool = buildTool({
  name: FFRAMES_TOOL_NAME,
  searchHint: 'ffmpeg ffprobe extract video frames thumbnails',
  maxResultSizeChars: 200_000,
  async description() { return DESCRIPTION },
  async prompt() { return PROMPT },
  get inputSchema(): InputSchema { return inputSchema() },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema { return outputSchema() },
  userFacingName() { return 'FFrames' },
  isConcurrencySafe(input) { return input.action !== 'extract' },
  isReadOnly(input) { return input.action !== 'extract' },
  toAutoClassifierInput(input) {
    return `${input.action}${input.input ? ` ${input.input}` : ''}`
  },
  async call(input: Input) {
    switch (input.action) {
      case 'reference': return { data: runReference(input.reference) }
      case 'script': return { data: runScript(input.script) }
      case 'list': return { data: runList() }
      case 'probe': return { data: await runProbe(input.input) }
      case 'extract': return { data: await runExtract(input.input, input.outputDir, input.timestamps) }
      case 'guide':
      default: return { data: runGuide() }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [output.summary]
    if (output.contentPath) lines.push(`Source: ${output.contentPath}${output.bytes ? ` (${output.bytes} bytes)` : ''}`)
    if (output.suggestedFilename) lines.push(`Suggested temp file: /tmp/${output.suggestedFilename}`)
    if (output.availableReferences?.length) lines.push(`References: ${output.availableReferences.map(r => `${r.name}(${r.bytes}b)`).join(', ')}`)
    if (output.availableScripts?.length) lines.push(`Scripts: ${output.availableScripts.map(s => `${s.name}[${s.language}](${s.bytes}b)`).join(', ')}`)
    if (output.frames?.length) lines.push(`Frames: ${output.frames.map(f => `${f.timestamp}->${f.path}`).join(', ')}`)
    if (output.content) lines.push(`Preview:\n${output.content.slice(0, 200)}${output.content.length > 200 ? '…' : ''}`)
    return { tool_use_id: toolUseID, type: 'tool_result', content: lines.join('\n') }
  },
} satisfies ToolDef<InputSchema, Output>)
```

---

## 3. Exact registration diff for `src/tools.ts`

No new imports are needed for FFramesTool internals; `src/tools.ts` is self-contained.

**(a) Import — insert after src/tools.ts:51 (`import { Prove2MeTool } ...`), before line 52:**

```ts
import { FFramesTool } from './tools/FFramesTool/FFramesTool.js'
```

Anchor (src/tools.ts:50–52):
```ts
import { DerefTool } from './tools/DerefTool/DerefTool.js'
import { Prove2MeTool } from './tools/Prove2MeTool/Prove2MeTool.js'
import { getSyntheticTools } from './services/functionHooks/plugins/jitSynthesisHook.js'
```

**(b) Array entry — insert after src/tools.ts:296 (`AwrStRunTool,`):**

```ts
    FFramesTool,
```

Anchor (src/tools.ts:294–297):
```ts
    LearnTool,
    AwrOpsTool,
    AwrStRunTool,
    NumberTheoryMasterTool,
```

Ordering is not semantic (all entries are collected into `getAllBaseTools()`), but keep it
next to its siblings so the diff stays reviewable. Do NOT add anything before line 1's
`// biome-ignore-all assist/source/organizeImports`.

---

## 4. Validation & completion gate

There is NO `--list-tools` flag in this CLI (verified: no such option in `src/main.tsx`,
no `getAllBaseTools` call in `src/entrypoints/`). Smoke-test tool loading by importing the
registry directly.

### 4.1 Tool load smoke (exact command)

```bash
bun -e "
import { getAllBaseTools } from './src/tools.ts'
const names = getAllBaseTools().map(t => t.name)
if (!names.includes('fframes')) { console.error('FAIL: fframes not registered'); process.exit(1) }
console.log('OK: fframes registered; total tools =', names.length)
"
```
Pass criterion: exit 0, prints `OK: fframes registered`.

### 4.2 Direct `call()` smoke (exact command)

```bash
cd /data/data/com.termux/files/home/opencc && bun -e "
import { FFramesTool } from './src/tools/FFramesTool/FFramesTool.ts'
const r = await FFramesTool.call({ action: 'list' }, {})
if (!r || typeof r !== 'object' || !('data' in r)) { console.error('FAIL: no {data}'); process.exit(1) }
console.log('OK action=list ->', r.data.success, r.data.availableReferences?.length, 'refs')
const g = await FFramesTool.call({ action: 'guide' }, {})
console.log('OK action=guide bytes ->', g.data.bytes)
const p = await FFramesTool.call({ action: 'probe' }, {})
console.log('OK action=probe missing-input ->', p.data.success === false)
"
```
Pass criteria: (1) each return has a `data` key; (2) `list` returns `success:true` with
`availableReferences`/`availableScripts` arrays; (3) `guide` returns non-zero `bytes`;
(4) `probe` with no `input` returns `success:false` (no throw).

### 4.3 Unit tests (bun test)

Existing patterns to copy: `src/services/functionHooks/plugins/__tests__/writeGuardHook.test.ts`
(dispatch + registrar), `src/services/functionHooks/__tests__/pluginStatus.test.ts`
(reset discipline).

Create:
- `src/tools/FFramesTool/__tests__/fframes.test.ts`

Run:
```bash
cd /data/data/com.termux/files/home/opencc && bun test src/tools/FFramesTool/__tests__/fframes.test.ts
```
Regression (proves a default-ON plugin did not break the opt-in invariant):
```bash
cd /data/data/com.termux/files/home/opencc && bun test src/services/functionHooks/__tests__/pluginStatus.test.ts
```
Pass criteria: all tests pass.

### 4.4 Build gate

```bash
cd /data/data/com.termux/files/home/opencc && bun run build
```
Pass criterion: exit 0 and `dist/cli.js` is produced (bundles the text assets inline).

### 4.5 Completion gate (do not claim done until all true)

1. `bun run build` exits 0.
2. 4.1 and 4.2 smoke commands exit 0.
3. 4.3 tests all pass, including the `pluginStatus.test.ts` regression.
4. Tool returns `{ data: ... }` and `mapToolResultToToolResultBlockParam` exists.
5. `FFramesTool` is present in `getAllBaseTools()`.

If any fails, report exactly which and stop — do not imply "done except tests".

---

## 5. Pitfalls found in the code

1. **`lazySchema` is a factory, not the schema.** Define
   `const inputSchema = lazySchema(() => z.strictObject({...}))`, then expose
   `get inputSchema() { return inputSchema() }`. Passing the factory where a schema is
   expected is the common bug (AwrOpsTool.ts:53, 242).
2. **`outputSchema` is optional on `Tool` (src/Tool.ts:400)** and `buildTool` does not
   enforce it. Define it anyway and keep it exactly in sync with the `data` shape; the API
   schema generator reads it.
3. **`inputJSONSchema` must set `schema.type = 'object'`** (AwrOpsTool.ts:245–248).
   `zodToJsonSchema` only adds it for `oneOf` unions (zodToJsonSchema.ts:33).
4. **Text-asset imports need BOTH the `with { type: 'text' }` attribute AND an ambient
   module declaration.** Bun inlines at build time; tsc needs
   `assets.d.ts`. The repo already has ~1341 tsc errors from decompilation that do NOT
   block Bun — do not try to zero them.
5. **`runCommand` returns non-zero as data, never throws** (runtime.ts:92). Branch on
   `exitCode`/`timedOut`; do not try/catch around it for command failure.
6. **Matcher primitives compare by strict equality** (matcher.ts:30) — match
   `{ tool_name: 'Bash' }` and test the command string in the body. A regex in the matcher
   matches nothing.
7. **`tool.call` rewrite must return `next({...e, tool_input: {...}})`**, not a bare hint
   object. plugins/index.ts:16 lists the only honored results (allow/deny/rewrite/context);
   anything else is dropped. Observer hooks (`tool.content`, `tool.error`) must
   `return next(e)` or `return await next(e)` to pass the payload through
   (knowledgeHook.ts:98–124).
8. **A new default-ON plugin MUST be added to the `resetBuiltinPlugins()` id array
   (plugins/index.ts:292–331).** Omission is a process-global test leak —
   `resetEngine()`/`resetBuiltinPlugins()` removes by id (registry.ts:71), and
   `pluginStatus.test.ts:62–67` will expose the extra registered plugin.
9. **Do not gate the tool behind `feature()`** — `feature()` always returns `false` in
   this build (CLAUDE.md), so any such branch is dead. `isEnabled` defaults to `true`
   (src/Tool.ts:758).
10. **`isReadOnly`/`isConcurrencySafe` are input-dependent** for fframes: `probe` is a
    read (safe concurrently), `extract` writes to disk (not read-only, not concurrent-safe).
    Claiming otherwise mismodels the tool.
11. **`shouldDefer` defaults to falsy** — omit it so the tool loads on turn 1. Setting
    `shouldDefer: true` requires a ToolSearch round-trip before the model can call it.
12. **Background-worker visibility is separate.** `ASYNC_AGENT_ALLOWED_TOOLS`
    (asserted in `src/tools/__tests__/specializedToolTriggers.test.ts:42–52`, sourced from
    `src/constants/tools.js`) gates which tools subagents may call. A brand-new tool is not
    in that set, so it is invisible to background workers until added there. Only touch it
    if subagent use is required.
13. **`src/tools.ts:1`** forbids import reordering; add the import in place, do not run a
    formatter over the file.
14. **`call()` signature is arity-flexible at runtime.** AwrOpsTool.ts:265 declares
    `async call(input: Input)` only; Bun passes extra args harmlessly. Keep the single-arg
    form for consistency with the template.
