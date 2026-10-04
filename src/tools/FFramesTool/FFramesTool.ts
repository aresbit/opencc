import { mkdir, rm, writeFile, readdir, readFile, stat, copyFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  GUIDE,
  GUIDE_PATH,
  getReference,
  listReferences,
  getTemplate,
  renderTemplate,
  FONT_FILE,
  type ReferenceAsset,
} from './assets.js'

const FRAMES_TOOL_NAME = 'fframes'

// Tool dir is resolvable from the module URL: in dev (`bun run src/...`) this is
// src/tools/FFramesTool; the bundled assets are inlined as text regardless.
const TOOL_DIR = import.meta.dir
const RENDERER_DIR = join(TOOL_DIR, 'renderer')
const RENDERER_BIN_DIR = join(RENDERER_DIR, 'target', 'release')
const RENDERER_BIN = join(RENDERER_BIN_DIR, 'fframes-render')
/** User cache for a built renderer, so the deployed bundle (no renderer/ beside it) still finds it. */
const CACHE_BIN = join(homedir(), '.cache', 'opencc', 'fframes-render')
const FONT_ABS = join(TOOL_DIR, FONT_FILE)

const DESCRIPTION = `FFrames 视频生成器 (fframes video generator) —— 把 Rust + SVG + ffmpeg 的视频框架 fframes 内置成工具：取回 SKILL.md 人格/方法论指南、API/音频/设计/Rust 核心参考文档，按真实 cargo-fframes 模板脚手架出一个 fframes 项目，或在本机直接把每帧 SVG 光栅化并编码成 .mp4（纯 CPU：resvg -> tiny-skia -> ffmpeg libx264，无需 GPU）。触发词："fframes"、"视频生成"、"生成视频"、"视频"、"动画"、"SVG 动画"、"render mp4"、"video"、"animation"、"svg to video"、"scaffold video project"。`

const USAGE_PROMPT = `
## 使用方式 (actions)

- \`guide\`  取回 fframes-video 指南正文 (SKILL.md)：框架心智模型、工作流、设计原则。可选 \`topic\` 只返回包含该关键词的章节。
- \`reference\`  取回打包的参考文档，\`reference\` 参数取 api / audio / design / rust-core-api。用 \`list\` 查看全部。
- \`list\`  列出所有打包参考文档及字节大小。
- \`scaffold\`  把一份真实的 fframes 项目源码写到 \`outputDir\`（Cargo.toml、src/lib.rs、src/main.rs、tests/frames.rs、README.md、.gitignore、media/DMSans-Medium.ttf）。参数：outputDir(必填)、template('single-scene'|'multi-scene')、title。
- \`render\`  在本机真正产出一个 .mp4。参数：outputPath(必填, .mp4)、scene({text,bg,fg}) 或 svgDir(每帧一个 SVG)、fps(默认 30)、duration 秒(默认 3)、size px(默认 640)。优先复用预编译渲染器（模块旁 / 安装目录旁 / ~/.cache/opencc / $OPENCC_FFRAMES_RENDERER）；仅当都不存在时才用 cargo 现场编译。

render 是无 GPU 的软件管线：每帧 SVG -> resvg/tiny-skia 光栅化为 PNG -> ffmpeg (libx264, yuv420p) 合成。渲染器与字体都打包在工具目录内，不依赖外部 fframes 安装。
`

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function refToSummary(r: ReferenceAsset): { name: string; bytes: number } {
  return { name: r.name, bytes: Buffer.byteLength(r.content, 'utf-8') }
}

/** Slice SKILL.md into sections (## headings); keep sections mentioning `topic`. */
function filterGuideByTopic(guide: string, topic: string): string {
  const needle = topic.trim().toLowerCase()
  if (!needle) return guide
  const parts = guide.split(/\n(?=## )/)
  const head = parts[0] ?? ''
  const matched = parts.slice(1).filter(p => p.toLowerCase().includes(needle))
  if (matched.length === 0) return guide
  return [head, ...matched].join('\n')
}

function runGuide(topic: string | undefined): Output {
  const filtered = topic ? filterGuideByTopic(GUIDE, topic) : GUIDE
  const note = topic ? ` (topic filter: "${topic}")` : ''
  return {
    success: true,
    action: 'guide',
    summary: `Loaded fframes-video guide (SKILL.md)${note}.`,
    content: filtered,
    contentPath: GUIDE_PATH,
    bytes: Buffer.byteLength(filtered, 'utf-8'),
  }
}

function runReference(reference: string | undefined): Output {
  const available = listReferences()
  if (!reference || !reference.trim()) {
    return {
      success: false,
      action: 'reference',
      summary: `action="reference" requires the "reference" parameter. Available: ${available
        .map(r => r.name)
        .join(', ')}.`,
      availableReferences: available.map(refToSummary),
    }
  }
  const ref = getReference(reference)
  if (!ref) {
    return {
      success: false,
      action: 'reference',
      summary: `Unknown reference "${reference}". Available: ${available
        .map(r => r.name)
        .join(', ')}.`,
      availableReferences: available.map(refToSummary),
    }
  }
  return {
    success: true,
    action: 'reference',
    summary: `Loaded fframes reference "${ref.name}".`,
    content: ref.content,
    contentPath: ref.path,
    bytes: Buffer.byteLength(ref.content, 'utf-8'),
  }
}

function runList(): Output {
  const refs = listReferences().map(refToSummary)
  return {
    success: true,
    action: 'list',
    summary: `fframes bundled assets: ${refs.length} references, ${getTemplate('Cargo.toml') ? '7' : '0'} scaffold templates.`,
    availableReferences: refs,
  }
}

// --- scaffold --------------------------------------------------------------

function sanitizeCrateName(raw: string): string {
  let n = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
  if (!n) n = 'fframes-video'
  return n
}

function toPascal(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

function toTitleCase(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

async function dirHasEntries(p: string): Promise<boolean> {
  try {
    const entries = await readdir(p)
    return entries.length > 0
  } catch {
    return false
  }
}

async function runScaffold(input: Input): Promise<Output> {
  const outputDir = input.outputDir
  if (!outputDir || !outputDir.trim()) {
    return {
      success: false,
      action: 'scaffold',
      summary: 'action="scaffold" requires "outputDir".',
    }
  }
  const template = input.template ?? 'single-scene'
  const name = sanitizeCrateName(basename(outputDir))
  const title = input.title ?? toTitleCase(name)
  const libName = name.replace(/-/g, '_')
  const struct = toPascal(name)

  if (await dirHasEntries(outputDir)) {
    return {
      success: false,
      action: 'scaffold',
      summary: `${outputDir} already exists and is not empty.`,
      outputDir,
    }
  }

  const width = 1920
  const height = 1080
  const fps = 30

  // Pin the crates.io release, exactly like `cargo fframes new --backend cpu` without
  // --fframes-path. The local ~/fframes-src checkout is incomplete (missing workspace
  // members fframes-media, fframes-skia-renderer, ...), so a `path = ...` dep would fail
  // to resolve; index.crates.io / static.crates.io serve the published 1.1.0 fine.
  const fframesDep = `fframes = { version = "=1.1.0", features = ["compile-time-svgtree", "cli"] }`
  const codecs = `\n[target.'cfg(not(windows))'.dependencies]\n${fframesDep.replace(
    'features = ["compile-time-svgtree", "cli"]',
    'features = ["h264", "libav-agree-gpl"]',
  )}\n`

  const isMulti = template === 'multi-scene'
  const vars: Record<string, string> = {
    crate_name: name,
    lib_name: libName,
    Struct: struct,
    title,
    width: String(width),
    height: String(height),
    fps: String(fps),
    media_path: 'media',
    fframes_dep: fframesDep,
    codecs,
    skia_dep: '',
    standalone_tables:
      '\n[workspace]\n\n[profile.dev]\nopt-level = 1\n\n[profile.dev.package."*"]\nopt-level = 3\n',
    backend_label: 'built-in CPU',
    run: 'cargo run --release --',
    preview_line: '',
    snapshot_specs: isMulti ? '"ProductScene@3s", "DataScene@3s"' : '"2s", "4s"',
    strip_range: isMulti ? 'DataScene' : '0..2s',
    entrance_range: isMulti ? 'ProductScene@0..ProductScene@1.5s' : '0..1.5s',
  }

  const libTpl = getTemplate(isMulti ? 'lib_multi_scene.rs' : 'lib_single_scene.rs')
  const files: Array<[string, string]> = [
    ['Cargo.toml', renderTemplate(getTemplate('Cargo.toml')!.content, vars)],
    ['src/lib.rs', renderTemplate(libTpl!.content, vars)],
    ['src/main.rs', renderTemplate(getTemplate('main_cpu.rs')!.content, vars)],
    ['tests/frames.rs', renderTemplate(getTemplate('frames_test.rs')!.content, vars)],
    ['README.md', renderTemplate(getTemplate('README.md')!.content, vars)],
    ['.gitignore', renderTemplate(getTemplate('gitignore')!.content, vars)],
  ]

  await mkdir(join(outputDir, 'src'), { recursive: true })
  await mkdir(join(outputDir, 'tests'), { recursive: true })
  await mkdir(join(outputDir, 'media'), { recursive: true })

  const written: string[] = []
  for (const [rel, content] of files) {
    await writeFile(join(outputDir, rel), content, 'utf-8')
    written.push(rel)
  }
  // The scaffold font is required for the generated video's default "DM Sans" text.
  if (await exists(FONT_ABS)) {
    await Bun.write(join(outputDir, 'media', 'DMSans-Medium.ttf'), Bun.file(FONT_ABS))
    written.push('media/DMSans-Medium.ttf')
  }

  return {
    success: true,
    action: 'scaffold',
    summary: `Wrote a real fframes ${template} project into ${outputDir} (${written.length} files, ${width}x${height} @ ${fps} fps, CPU backend).`,
    outputDir,
    filesWritten: written,
  }
}

// --- render ----------------------------------------------------------------

interface CmdResult {
  code: number
  stdout: string
  stderr: string
}

async function runCmd(args: string[], cwd?: string, signal?: AbortSignal): Promise<CmdResult> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe', signal, env: toolEnv() })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** PATH augmented with the usual toolchain dirs, so cargo/ffmpeg/ffprobe resolve
 *  even when the CLI was launched with a minimal PATH (e.g. a bundle spawned by
 *  a GUI/daemon, or Termux where the linker bin dir is not exported). */
function toolEnv(): Record<string, string> {
  const extra = [
    RENDERER_BIN_DIR,
    join(homedir(), '.cargo', 'bin'),
    process.env.PREFIX ? join(process.env.PREFIX, 'bin') : '',
    '/data/data/com.termux/files/usr/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((v): v is string => !!v)
  const path = [...extra, ...(process.env.PATH ?? '').split(':')]
    .filter((v, i, a) => v && a.indexOf(v) === i)
    .join(':')
  return { ...(process.env as Record<string, string>), PATH: path }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** A prebuilt renderer may live next to this module (dev tree), next to the
 *  installed bundle, in a user cache written by a previous build, or at a path
 *  given by OPENCC_FFRAMES_RENDERER. `render` must not need cargo when one of
 *  these already exists — that was the bug: the deployed bundle had no
 *  `renderer/` next to it, so it fell through to a `cargo build` whose spawn
 *  could not even find cargo. */
async function findRendererBin(): Promise<string | null> {
  const candidates = [
    process.env.OPENCC_FFRAMES_RENDERER,
    RENDERER_BIN,
    join(TOOL_DIR, 'renderer', 'fframes-render'),
    CACHE_BIN,
  ].filter((p): p is string => !!p)
  for (const p of candidates) {
    if (await exists(p)) return p
  }
  return null
}

/** Resolve a usable cargo: the augmented PATH first, then well-known locations. */
async function resolveCargo(): Promise<string | null> {
  const r = await runCmd(['sh', '-c', 'command -v cargo 2>/dev/null || true'])
  const found = r.stdout.trim().split('\n')[0]?.trim()
  if (found) return found
  for (const p of [
    join(homedir(), '.cargo', 'bin', 'cargo'),
    process.env.PREFIX ? join(process.env.PREFIX, 'bin', 'cargo') : '',
    '/usr/local/bin/cargo',
    '/usr/bin/cargo',
  ]) {
    if (p && (await exists(p))) return p
  }
  return null
}

async function ensureRenderer(log: string[], signal?: AbortSignal): Promise<string> {
  const present = await findRendererBin()
  if (present) {
    log.push(`renderer present: ${present}`)
    return present
  }

  const srcDir = (await exists(join(RENDERER_DIR, 'Cargo.toml')))
    ? RENDERER_DIR
    : (await exists(join(TOOL_DIR, 'renderer', 'Cargo.toml')))
      ? join(TOOL_DIR, 'renderer')
      : null
  if (!srcDir) {
    throw new Error(
      'renderer binary not found and no renderer sources to build from. ' +
        `Looked for a prebuilt fframes-render (${[RENDERER_BIN, join(TOOL_DIR, 'renderer', 'fframes-render'), CACHE_BIN].join(', ')}) ` +
        'and for renderer/Cargo.toml next to the tool. Set OPENCC_FFRAMES_RENDERER to a prebuilt fframes-render.',
    )
  }

  const cargo = await resolveCargo()
  if (!cargo) {
    throw new Error(
      'no prebuilt renderer and no cargo to build one. Install Rust (or set PATH to include cargo), ' +
        'or point OPENCC_FFRAMES_RENDERER at a prebuilt fframes-render.',
    )
  }
  log.push(`building renderer: ${cargo} build --release (cwd ${srcDir})`)
  const r = await runCmd([cargo, 'build', '--release'], srcDir, signal)
  log.push(`cargo build --release exited ${r.code}`)
  if (r.code !== 0) {
    throw new Error(`renderer build failed:\n${clip(r.stderr, 4000)}`)
  }
  const built = join(srcDir, 'target', 'release', 'fframes-render')
  if (!(await exists(built))) {
    throw new Error('cargo build reported success but the renderer binary is missing')
  }
  // Cache it so the deployed bundle (which has no renderer/ beside it) finds it next time.
  try {
    if (built !== CACHE_BIN) {
      await mkdir(dirname(CACHE_BIN), { recursive: true })
      await copyFile(built, CACHE_BIN)
      log.push(`cached renderer: ${CACHE_BIN}`)
    }
  } catch {
    // caching is best-effort; the freshly built path still works this run
  }
  return built
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const easeOut = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3)

/** One declarative frame, no fframes needed: text + colors, animated over `t` in [0,1]. */
function sceneSvg(t: number, scene: NonNullable<Input['scene']>, size: number): string {
  const bg = scene.bg ?? '#0b1020'
  const fg = scene.fg ?? '#ffffff'
  const text = scene.text ?? 'fframes'
  const opacity = (0.12 + 0.88 * easeOut(t / 0.5)).toFixed(3)
  const dy = ((1 - easeOut(t / 0.6)) * size * 0.08).toFixed(2)
  const fontSize = Math.round(size * 0.11)
  const cx = size / 2
  const cy = size / 2
  const barW = (size * 0.6 * Math.min(1, Math.max(0, t))).toFixed(2)
  const stroke = (size * 0.006).toFixed(2)
  const barH = Math.max(2, Math.round(size * 0.012))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <circle cx="${cx}" cy="${cy}" r="${(size * 0.34).toFixed(2)}" fill="none" stroke="${fg}" stroke-opacity="0.12" stroke-width="${stroke}"/>
  <text x="${cx}" y="${cy + Number(dy) + fontSize * 0.35}" font-family="DM Sans" font-size="${fontSize}" font-weight="600" fill="${fg}" fill-opacity="${opacity}" text-anchor="middle">${escapeXml(text)}</text>
  <rect x="${(cx - Number(barW) / 2).toFixed(2)}" y="${(cy + size * 0.24).toFixed(2)}" width="${barW}" height="${barH}" rx="${(size * 0.006).toFixed(2)}" fill="${fg}" fill-opacity="0.85"/>
</svg>
`
}

const pad4 = (n: number) => String(n).padStart(4, '0')

async function runRender(input: Input, signal?: AbortSignal): Promise<Output> {
  const outputPath = input.outputPath
  if (!outputPath || !outputPath.trim()) {
    return {
      success: false,
      action: 'render',
      summary: 'action="render" requires "outputPath" (a .mp4 path).',
    }
  }
  const fps = input.fps && input.fps > 0 ? Math.floor(input.fps) : 30
  const duration = input.duration && input.duration > 0 ? input.duration : 3
  const size = input.size && input.size > 0 ? Math.floor(input.size) : 640
  const log: string[] = []

  const work = await mkdtempBun('fframes-')
  const svgTmp = join(work, 'svg')
  const pngTmp = join(work, 'png')
  await mkdir(svgTmp, { recursive: true })
  await mkdir(pngTmp, { recursive: true })

  try {
    // (b) one SVG per frame, no fframes.
    const frameCount = Math.max(1, Math.round(fps * duration))
    const frames: string[] = []
    if (input.svgDir && input.svgDir.trim()) {
      const entries = (await readdir(input.svgDir))
        .filter(f => f.toLowerCase().endsWith('.svg'))
        .sort()
      if (entries.length === 0) {
        return {
          success: false,
          action: 'render',
          summary: `No .svg files found in svgDir "${input.svgDir}".`,
        }
      }
      for (const f of entries) frames.push(await readFile(join(input.svgDir, f), 'utf-8'))
      log.push(`svgDir: ${entries.length} SVG frames from ${input.svgDir}`)
    } else {
      const scene = input.scene ?? {}
      for (let i = 0; i < frameCount; i++) {
        const t = frameCount === 1 ? 1 : i / (frameCount - 1)
        frames.push(sceneSvg(t, scene, size))
      }
      log.push(`generated ${frames.length} SVG frames (fps ${fps}, ${duration}s, ${size}px)`)
    }

    const svgPaths: string[] = frames.map((svg, i) => {
      const p = join(svgTmp, `f${pad4(i)}.svg`)
      return p
    })
    for (let i = 0; i < frames.length; i++) {
      await writeFile(svgPaths[i]!, frames[i]!, 'utf-8')
    }

    // (a) ensure the renderer.
    const bin = await ensureRenderer(log, signal)

    // (c) rasterise each frame -> PNG.
    const fontArg = (await exists(FONT_ABS)) ? FONT_ABS : undefined
    for (let i = 0; i < frames.length; i++) {
      const pngPath = join(pngTmp, `f${pad4(i)}.png`)
      const args = [bin, svgPaths[i]!, pngPath, String(size)]
      if (fontArg) args.push(fontArg)
      const r = await runCmd(args, undefined, signal)
      if (r.code !== 0) {
        throw new Error(`frame ${i} rasterise failed (exit ${r.code}):\n${clip(r.stderr, 2000)}`)
      }
    }
    log.push(`rasterised ${frames.length} frames to PNG (resvg/tiny-skia)`)

    // (d) encode with ffmpeg.
    await mkdir(dirname(outputPath), { recursive: true })
    const pattern = join(pngTmp, 'f%04d.png')
    const ff = await runCmd(
      [
        'ffmpeg',
        '-y',
        '-framerate',
        String(fps),
        '-i',
        pattern,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        outputPath,
      ],
      undefined,
      signal,
    )
    log.push(`ffmpeg exited ${ff.code}`)
    if (ff.code !== 0) {
      throw new Error(`ffmpeg failed (exit ${ff.code}):\n${clip(ff.stderr, 4000)}`)
    }

    // (e) probe the result.
    const probe = await runCmd(
      [
        'ffprobe',
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,width,height,nb_frames:format=duration',
        '-of',
        'json',
        outputPath,
      ],
      undefined,
      signal,
    )
    let codec: string | undefined
    let vw: number | undefined
    let vh: number | undefined
    let nbFrames: number | undefined
    let durationSeconds: number | undefined
    try {
      const parsed = JSON.parse(probe.stdout) as {
        streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_frames?: string }>
        format?: { duration?: string }
      }
      const st = parsed.streams?.[0]
      codec = st?.codec_name
      vw = st?.width
      vh = st?.height
      nbFrames = st?.nb_frames ? Number(st.nb_frames) : undefined
      durationSeconds = parsed.format?.duration ? Number(parsed.format.duration) : undefined
    } catch {
      // leave fields undefined; probeRaw still carries the output
    }

    return {
      success: true,
      action: 'render',
      summary: `Rendered ${outputPath}: ${codec ?? '?'} ${vw ?? '?'}x${vh ?? '?'}, ${
        nbFrames ?? frames.length
      } frames @ ${fps} fps.`,
      outputPath,
      fps,
      durationSeconds,
      size,
      frames: frames.length,
      videoCodec: codec,
      videoWidth: vw,
      videoHeight: vh,
      nbFrames,
      probeRaw: probe.stdout.trim(),
      log: log.join('\n'),
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function mkdtempBun(prefix: string): Promise<string> {
  // os.tmpdir() honours TMPDIR (which is a writable path on this host; /tmp is not).
  const base = tmpdir()
  const dir = join(base, `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(dir, { recursive: true })
  return dir
}

// --- schema ----------------------------------------------------------------

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['guide', 'reference', 'list', 'scaffold', 'render'])
      .describe(
        'guide: fframes-video guide (SKILL.md). reference: a bundled reference doc. list: list references. scaffold: write a real fframes project. render: rasterise SVG frames and encode a real .mp4.',
      ),
    topic: z
      .string()
      .optional()
      .describe('Only for guide: return only sections mentioning this topic.')
      .meta({ eligibleActions: ['guide'] }),
    reference: z
      .string()
      .optional()
      .describe('Only for reference: api / audio / design / rust-core-api. Use list to see all.')
      .meta({ eligibleActions: ['reference'] }),
    outputDir: z
      .string()
      .optional()
      .describe('Only for scaffold: directory to write the project into (must be empty or absent).')
      .meta({ eligibleActions: ['scaffold'] }),
    template: z
      .enum(['single-scene', 'multi-scene'])
      .optional()
      .describe('Only for scaffold: which lib template. Default single-scene.')
      .meta({ eligibleActions: ['scaffold'] }),
    title: z
      .string()
      .optional()
      .describe('Only for scaffold: title shown in the video. Defaults to a title-cased project name.')
      .meta({ eligibleActions: ['scaffold'] }),
    outputPath: z
      .string()
      .optional()
      .describe('Only for render: the .mp4 output path (required for render).')
      .meta({ eligibleActions: ['render'] }),
    scene: z
      .object({
        text: z.string().optional().describe('Text to draw (default "fframes").'),
        bg: z.string().optional().describe('Background CSS color (default "#0b1020").'),
        fg: z.string().optional().describe('Foreground/text CSS color (default "#ffffff").'),
      })
      .optional()
      .describe('Only for render: a simple declarative scene {text,bg,fg}. Ignored when svgDir is set.')
      .meta({ eligibleActions: ['render'] }),
    svgDir: z
      .string()
      .optional()
      .describe('Only for render: a directory with one .svg per frame (sorted by name) instead of scene.')
      .meta({ eligibleActions: ['render'] }),
    fps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only for render: frames per second. Default 30.')
      .meta({ eligibleActions: ['render'] }),
    duration: z
      .number()
      .positive()
      .optional()
      .describe('Only for render: seconds. Default 3. Ignored when svgDir is set.')
      .meta({ eligibleActions: ['render'] }),
    size: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only for render: output edge length in px (square). Default 640.')
      .meta({ eligibleActions: ['render'] }),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the request succeeded'),
    action: z.enum(['guide', 'reference', 'list', 'scaffold', 'render']).describe('Action run'),
    summary: z.string().describe('One-line summary'),
    content: z.string().optional().describe('Returned document body (guide/reference)'),
    contentPath: z.string().optional().describe('Logical asset path (guide/reference)'),
    bytes: z.number().int().optional().describe('Byte size of returned content (guide/reference)'),
    availableReferences: z
      .array(z.object({ name: z.string(), bytes: z.number() }))
      .optional()
      .describe('Available references (list, or a reference failure)'),
    outputDir: z.string().optional().describe('Project directory (scaffold)'),
    filesWritten: z.array(z.string()).optional().describe('Relative files written (scaffold)'),
    outputPath: z.string().optional().describe('Output .mp4 path (render)'),
    fps: z.number().optional().describe('Frames per second (render)'),
    durationSeconds: z.number().optional().describe('Probed video duration in seconds (render)'),
    size: z.number().optional().describe('Output edge length px (render)'),
    frames: z.number().int().optional().describe('Number of frames encoded (render)'),
    videoCodec: z.string().optional().describe('Probed video codec (render)'),
    videoWidth: z.number().optional().describe('Probed video width (render)'),
    videoHeight: z.number().optional().describe('Probed video height (render)'),
    nbFrames: z.number().optional().describe('Probed frame count (render)'),
    probeRaw: z.string().optional().describe('Raw ffprobe JSON (render)'),
    log: z.string().optional().describe('Step log (render)'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const FFramesTool = buildTool({
  name: FRAMES_TOOL_NAME,
  searchHint: 'fframes rust svg video render mp4 ffmpeg animation scaffold timeline',
  maxResultSizeChars: 200_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION + USAGE_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'FFrames'
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action} ${input.outputPath ?? input.reference ?? input.outputDir ?? ''}`.trim()
  },
  async call(input: Input, context?: { abortSignal?: AbortSignal }) {
    const signal = context?.abortSignal
    switch (input.action) {
      case 'reference':
        return { data: runReference(input.reference) }
      case 'list':
        return { data: runList() }
      case 'scaffold':
        return { data: await runScaffold(input) }
      case 'render': {
        try {
          return { data: await runRender(input, signal) }
        } catch (err) {
          return {
            data: {
              success: false,
              action: 'render',
              summary: `render failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
              log: err instanceof Error ? err.message : String(err),
            },
          } satisfies Output
        }
      }
      case 'guide':
        return { data: runGuide(input.topic) }
      default:
        // Unreachable through the harness — inputSchema constrains `action` to
        // the enum — but a direct caller can pass anything. Do not silently
        // answer with the guide and report success for a typo'd action.
        return {
          data: {
            success: false,
            action: input.action,
            summary: `Unknown action "${String(input.action)}". Valid actions: guide, reference, list, scaffold, render.`,
          } as Output,
        }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = [output.summary]

    if (output.contentPath) {
      const sizeInfo = output.bytes ? ` (${output.bytes} bytes)` : ''
      lines.push(`Source: ${output.contentPath}${sizeInfo}`)
    }
    if (output.filesWritten && output.filesWritten.length > 0) {
      lines.push(`Wrote: ${output.filesWritten.join(', ')}`)
    }
    if (output.availableReferences && output.availableReferences.length > 0) {
      lines.push(
        `References: ${output.availableReferences.map(r => `${r.name}(${r.bytes}b)`).join(', ')}`,
      )
    }
    if (output.outputPath) {
      const info = [
        output.videoCodec,
        output.videoWidth && output.videoHeight
          ? `${output.videoWidth}x${output.videoHeight}`
          : undefined,
        output.nbFrames != null ? `${output.nbFrames} frames` : undefined,
      ]
        .filter(Boolean)
        .join(' ')
      lines.push(`Output: ${output.outputPath}${info ? ` (${info})` : ''}`)
    }
    if (output.log) {
      lines.push(`Log:\n${clip(output.log, 1500)}`)
    }
    if (output.content) {
      const preview = output.content.slice(0, 200)
      const ellipsis = output.content.length > 200 ? '…' : ''
      lines.push(`Preview:\n${preview}${ellipsis}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
