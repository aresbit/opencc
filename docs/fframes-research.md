# fframes → opencc research (evidence base)

Researcher task `sg_musfn0oe_2`. Target repo: `https://github.com/dmtrKovalenko/fframes`.
Source revision fetched: `main` @ tree `bae393f6192ea469a9e3943afe7ed5be455e773a`.

## Environment / method note (read first)

- **`/tmp` is NOT writable on this host.** It is `drwxrwx--x shell shell`. The task's
  "write only to `/tmp/fframes-work/`" was therefore carried out in the Termux temp area:
  **`/data/data/com.termux/files/usr/tmp/fframes-work/`** (`$PREFIX/tmp`). Everything referenced
  below lives there. The report itself is at
  `/data/data/com.termux/files/home/opencc/docs/fframes-research.md`.
- **Direct `github.com` git clone stalls / is reset on this host** (`curl https://raw.githubusercontent.com/...` → exit 35
  "Connection reset by peer"; `git clone https://github.com/...` hangs). `git clone` was therefore done
  through the mirror **`https://gh-proxy.com/https://github.com/...`**, and individual source files were read
  from **`https://gh-proxy.com/https://raw.githubusercontent.com/dmtrKovalenko/fframes/main/<path>`** and
  **`https://gcore.jsdelivr.net/gh/dmtrKovalenko/fframes@main/<path>`**. no commit was made.
- Host facts (given, not re-verified): cargo/rustc 1.97.1, ffmpeg 8.1.2, bun 1.3.13, python3 3.14,
  aarch64 Android, no GPU/Vulkan/Metal. Confirmed this session: `rustc -vV` → `host: aarch64-linux-android`.

---

## Verdict

1. **NO — fframes itself cannot be built on this host** (`cargo build` / `cargo install fframes`):
   the sole hard native dependency, `ffmpeg-sys-fframes` 9.0.0, has **no prebuilt for
   `aarch64-linux-android`** (HTTP 404) and then tries to **`git clone` FFmpeg from github.com, which
   does not complete on this network** (exit 124); even with network it needs the Android NDK via
   cargo-ndk (`CC_<triple>`, `CARGO_NDK_SYSROOT_PATH`).
2. **Partial — `cargo install --locked cargo-fframes` (the project scaffolder) DOES build successfully**
   here (exit 0, 2m41s). It is pure Rust (clap + dialoguer) and gives you `cargo fframes new`.
3. **Usable render path today = external toolchain, not the fframes crate**: produce frames as
   PNG (Python stdlib / resvg / headless Chromium) → encode with the host `ffmpeg` (libx264 present).
   Proven end-to-end below.

---

## API surface (verbatim, with file:line)

All line numbers are from the fetched files (repo `main` @ `bae393f`).

### `Video` trait — `fframes/src/video.rs`

```rust
// fframes/src/video.rs:10
pub trait Video: Sync + Sized {
    const FPS: usize;
    const WIDTH: usize;
    const HEIGHT: usize;
    const BACKGROUND_COLOR: Color = Color::BLACK;   // :20

    fn duration(&self) -> Duration<'_>;                          // :23
    fn audio(&self) -> AudioMap<'_>;                             // :26
    fn define_scenes(&self) -> Scenes<'_> { Scenes(None) }       // :64  (optional)
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a>; // :79
}
```
Note: the doc-comment example on `define_scenes` (`video.rs:36-63`) still writes `fn define_scenes`
while `lib.rs`'s example writes `fn define_scenes`; the real method name is **`define_scenes`**
(`video.rs:64`). `render_frame` is called for **every frame on all cores** and must be pure —
no I/O, no panics (`video.rs:71-78`).

### `svgr!` macro — `svgr-macro/src/lib.rs`

```rust
// svgr-macro/src/lib.rs:82
#[proc_macro]
pub fn svgr(tokens: TokenStream) -> TokenStream {
    let fframes_crate_ident = match proc_macro_crate::crate_name("fframes")
        .expect("fframes crate must be present in Cargo.toml") { ... };
    ...
    Ok(quote! {{
         use #fframes_crate_ident::usvgr::svgtree::macro_prelude::*;
         #fframes_crate_ident::lazy_static::lazy_static! { #(#animations)* }
         #[allow(unused_braces)]
         #[allow(clippy::approx_constant)]
         #svgr_ident
    }})
}
```
- **Returns a `fframes::Svgr<'a>`** (the macro builds `fframes::Svgr { value: format!(...) , .. }`, or a
  compile-time `svg_tree` when the `compile-time-svgtree` feature is on — `svgr-macro/src/lib.rs:42-70`).
- `Svgr` — `fframes/src/svgr.rs:5`: `pub struct Svgr<'a> { value: String, marker: PhantomData<&'a str> }`
  (runtime form) or `svg_tree: usvgr::svgtree::NestedSvgDocument<..>` (compile-time form).
  `Svgr::empty()` at `svgr.rs:48`; `From<String>`, `From<&str>`, `FromIterator` at `svgr.rs:54-148`.
- Usage form (from the crate docs `fframes/src/lib.rs:56`):

```rust
fframes::svgr!(
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"
         width={Self::WIDTH} height={Self::HEIGHT}>
        <text x="120" y="560" font-family="DM Sans" font-size="150" fill="#fff"
              opacity={opacity}>
            "Hello " {self.title}
        </text>
    </svg>
)
```
Literal text children are **quoted strings**; `{expr}` interpolates attributes and children
(`String`/`&str`/number/`Color`/`Transform`/`Svgr`/`Vec<Svgr>`). Comments are `//` lines.
Subtrees with no `{}` are hashed at compile time and cached across frames
(`skills/fframes-video/references/api.md:27-29`).

### `timeline!` macro + `frame.animate` — `fframes/src/animation/animation.rs`, `fframes/src/frame.rs`

```rust
// fframes/src/animation/animation.rs:273  — the exact macro
#[macro_export]
macro_rules! timeline {
    ($(at $start:expr $(=> $end:expr)?, animate $from:expr => $to:expr, $easing:expr),+ $(,)?) => {
        fframes::animation::KeyFramesAnimation::new(vec![
            $( fframes::animation::KeyFrame {
                    start: $start,
                    end: $crate::option_literal!($($end)?),
                    from: $from, to: $to, easing: &$easing, }, )+
        ])
    };
    ($(at $start:expr $(, duration $duration:expr)?, animate $from:expr => $to:expr, $easing:expr),+ $(,)?) => {
        fframes::animation::KeyFramesAnimation::new(vec![
            $( fframes::animation::KeyFrame {
                    start: $start,
                    end: $crate::option_duration!($start, $($duration)?),
                    from: $from, to: $to, easing: &$easing, }, )+
        ])
    };
}
// fframes/src/animation/animation.rs:304  option_duration:  (at S, duration D) => Some(S + D)
// fframes/src/animation/animation.rs:314  option_literal:   (at S => E)       => Some(E)
```

**Time units for `timeline!` are SECONDS (f32), not frames.** `KeyFrame.start/end` are documented
"Start/End time of the keyframe **in seconds**" (`animation.rs:151-159`). To animate by frames use
`frame.animate_runtime(AnimateRuntimeInput { on_second: frame.frame_to_second(10), .. })`
(`frame.rs:29-31`). The frames / seconds / percent / scene-offset grammar is the **CLI time-spec**
grammar (see CLI reference), *not* `timeline!`.

Easing — `fframes/src/animation/animation.rs:65`:
```rust
pub enum Easing {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    CubicBezier(f32, f32, f32, f32),                 // cubic-bezier(x1,y1,x2,y2)
    Spring { mass: f32, stiffness: f32, damping: f32 },  // Apple WebKit spring physics
}
```
Animatable values: `f32`, `f64`, `(f32,f32)`, `(f32,f32,f32)`, `(f32,f32,f32,f32)` implement
`Animatable` (`animation.rs:120-148`); the docs additionally list `Color` and `Transform`
(`references/api.md:81`).

Applications — `fframes/src/frame.rs`:
```rust
pub fn animate<T: Animatable + Copy + Default + Debug>(&self, animation: &KeyFramesAnimation<T>) -> T   // :196
pub fn animate_loop<T: ...>(&self, animation: &KeyFramesAnimation<T>) -> T                               // :204
pub fn animate_runtime<T: Animatable>(&self, AnimateRuntimeInput { on_second, from, to, animation_runtime }) -> T // :126
pub fn seconds(&self) -> f32            // :96   (scene-relative inside a scene)
pub fn frame_to_second(&self, frame: usize) -> f32  // :101
pub fn second_to_frame(&self, second: f32) -> usize // :106
```
`Frame` fields (`frame.rs:16-26`): `index` (scene-relative), `global_index`, `fps`.

Canonical usage (from the crate doc `fframes/src/lib.rs:53`):
```rust
let opacity = frame.animate(&fframes::timeline!(
    at 0.0 => 0.5, animate 0.0_f32 => 1.0, Easing::EaseOut
));
```
Before the first keyframe the value is `from`; after the last it holds `to`.

### Scenes — `fframes/src/scenes.rs`

```rust
// scenes.rs:47
pub trait Scene: Debug + Sync + Send {
    fn duration(&self) -> crate::Duration<'_>;
    fn render_frame<'a>(&'a self, frame: crate::Frame, ctx: &crate::FFramesContext<'a, '_>) -> Svgr<'a>;
    fn overlap(&self) -> Overlap { Overlap::None }          // :55
    fn audio(&self) -> crate::audio_map::AudioMap<'_> { AudioMap::none() }  // :59
    fn name(&self) -> &'static str { std::any::type_name::<Self>() }        // :63
}
// scenes.rs:4
pub enum Overlap {
    Previous(f32), Next(f32), PreviousAndNext { previous: f32, next: f32 }, None,
}
```
`Scenes<'a>(Option<Vec<&'a (dyn Scene + 'a)>>)`, built with `Scenes::from(vec![&a as &dyn Scene, ...])`
(`scenes.rs:68-95`). Scenes are placed back to back; `Overlap::Previous(0.4)` cross-fades.
`SceneInfo { index, start_frame, end_frame, duration_in_frames, total_scenes_in_video, is_last }`
(`scenes.rs:29`). `Video::define_scenes` and `Duration::Auto` interact in
`resolve_timeline` (`video.rs:145-201`).

### `Duration` — `fframes/src/duration.rs`

```rust
// duration.rs:9
pub enum Duration<'a> {
    FromAudio(&'a str),      // length = duration of a media file
    FromVideo(&'a str),
    Seconds(f32),
    Frames(usize),
    Auto,                    // inferred from scenes / audio map
    __Add(Rc<(Duration,Duration)>),       // `+` operator
    __Subtract(Rc<(Duration,Duration)>),  // `-` operator
}
```

### `AudioMap` / `AudioTrack` — `fframes/src/audio_map.rs`

```rust
// audio_map.rs:172
type AudioDuration<'a> = Range<AudioTimestamp<'a>>;

// audio_map.rs:10
pub enum AudioTimestamp<'a> {
    Eof,                       // end of the file, relative to the start of the range
    Frame(usize), Second(f32), Time { minutes: f32, seconds: f32 },
    DurationOfAudio(&'a str),
    __Add(..), __Subtract(..),
}

// audio_map.rs:285
pub struct AudioTrack<'a> { pub file: &'a str, pub range: AudioDuration<'a>, pub mix: TrackMix }
impl<'a> AudioTrack<'a> {
    pub fn new(file: &'a str, range: AudioDuration<'a>) -> Self;  // :292
    pub fn gain_db(f32) -> Self;      // :300
    pub fn volume(f32) -> Self;       // :306   linear, 0.5 ≈ -6 dB
    pub fn pan(f32) -> Self;          // :311   clamped [-1,1]
    pub fn fade_in(f32) -> Self;      // :316   seconds
    pub fn fade_out(f32) -> Self;     // :321
    pub fn fade_curve(FadeCurve) -> Self; // :326  (FadeCurve enum at :177)
    pub fn offset(f32) -> Self;       // :332   start `seconds` into the file
    pub fn voice(mut self) -> Self;   // :338
    pub fn duck_under_voice(self) -> Self;  // :344  −12 dB while voice plays
    pub fn duck(Ducking) -> Self;     // :348   (Ducking struct at :212)
}

// audio_map.rs:383
pub struct AudioMap<'a>(pub Option<Vec<AudioTrack<'a>>>);
impl AudioMap<'_> { pub fn none() -> Self; /* :429 */ }
```
`Second`/`Eof` are variants of `AudioTimestamp`; bring them in with `use fframes::AudioTimestamp::*;`
(the crate lints table, `Cargo.toml:90`, calls this "the documented way"). Whole-map helpers:
`From<[(file, range); N]>` (`audio_map.rs:568`) and `FromIterator<(&str, AudioDuration)>` (`:586`),
so `AudioMap::from([AudioTrack::new("music.mp3", Second(0.)..Eof).gain_db(-18.).fade_in(1.)])`.
Ducking/limiter: `AudioMixOptions` (default limiter −1 dBFS, de-click fades) —
`skills/fframes-video/SKILL.md:225-228`, `references/api.md:159`.

### GPU shaders (SkSL / Shadertoy) — `fframes/src/shader.rs`

```rust
// shader.rs:12
pub enum ShaderLanguage { Sksl, Shadertoy }

// shader.rs:28
pub struct Shader { inner: Arc<ShaderInner> }   // cheap to clone, compiled-once & cached

impl Shader {
    pub fn sksl(source: impl Into<String>) -> Self;          // :62  entry: half4 main(float2 coord)
    pub fn shadertoy(source: impl AsRef<str>) -> Self;       // :79  entry: void mainImage(out vec4, in vec2)
    pub fn id(&self) -> u64;                                 // :98
    pub fn language(&self) -> ShaderLanguage;                // :102
    pub fn sksl_source(&self) -> &str;                       // :107
    pub fn draw(&self, frame: &Frame, uniforms: ShaderUniforms) -> ImageData<'static>;  // :116
}
```
- Built-in uniforms: `iResolution`, `iTime`, `iTimeDelta`, `iFrame` (declared for you);
  Shadertoy also declares `iMouse`, `iDate` and puts `fragCoord` at the bottom-left
  (`shader.rs:66-78`). Bind images with `ShaderUniforms::image("iChannel0", ..)`.
- `Shader::shadertoy` is a **textual** GLSL→SkSL translation (`shadertoy_to_sksl`, `shader.rs:374`):
  object-like `#define` expanded, `precision` dropped, but **function-like macros, `while` loops,
  non-constant loop bounds and `texture()` are unsupported** (`shader.rs:72-78`).
- **Only the Skia backend executes shaders** (`references/api.md:150`); the CPU backend draws
  nothing in their place. Usage (`references/api.md:128-139`):
```rust
let aurora = Shader::sksl(include_str!("shaders/aurora.sksl"));       // once, in the constructor
let layer = self.aurora.draw(&frame, ShaderUniforms::new().float("uSpeed", 0.6).color("uTint", tint));
fframes::svgr!(<image href={layer.href()} x="0" y="0" width="1920" height="1080" />)
```

### `FFramesContext` (used by `render_frame`) — `skills/fframes-video/references/api.md`

`ctx.render_scenes(&frame)` (video frame renders the active scene(s)); `ctx.get_scene_info(&scene)`;
`ctx.current_video_size` (output size, scaled by `--scale`); `ctx.get_image("logo.png") -> Option`;
`ctx.get_subtitles("subs.vtt)`. Text helpers on `frame`: `frame.text_width`,
`frame.text_fit(.., TextOverflow::Ellipsis)`, `frame.text_break_lines(..)` (`api.md:89-121`).
Media: `include_media_dir!(pub struct MyMedia, "media")` + `MyMedia::prepare()` (`api.md:113-115`),
or runtime `MediaDirectory::read_folder("assets")?` + `CombinedMediaProvider` (`api.md:116-117`).

---

## CLI reference (real flags)

**Two different CLIs — do not conflate them.**

### A. `cargo-fframes` (the scaffolder) — `cargo-fframes/src/main.rs`

Only one real subcommand:
```
cargo-fframes <COMMAND>
  new   Create a new video project
```
`cargo fframes new [OPTIONS] [NAME]` flags (verbatim from `cargo fframes new --help`):
`--title`, `--template single-scene|multi-scene`, `--backend cpu|skia-metal|skia-vulkan`,
`--format landscape|portrait|square|uhd`, `--fps`, `--dir`, `--fframes-path <path>`, `--git`,
`-y/--yes`. It writes: `Cargo.toml`, `src/lib.rs`, `src/main.rs`, `tests/frames.rs`,
`README.md`, `.gitignore`, `media/DMSans-Medium.ttf`.

### B. The per-project CLI = `fframes::cli` (feature `cli`), invoked as `cargo run --release -- <cmd>`

`fframes/src/renderer/cli.rs`. Global flags (`cli.rs:48-63`): **`--json`** (one JSON doc to stdout,
progress to stderr) and **`--scale <f64>`** (output resolution factor, e.g. `0.5`).

`enum Command` (`cli.rs:77-100`):

| command | args (verbatim `#[arg]`) |
|---|---|
| `render [RANGE]` (default) | `-o, --output <FILE>`; `--draft` (half res + fastest preset) `cli.rs:122-131` |
| `frame <AT...>` | `at` required, comma-delimited; `-o, --output <dir>` default `frames`; `--svg` `cli.rs:134-143` |
| `strip [RANGE]` | `-n, --count` default 12; `--columns` default 4; `--width` default 480; `-o, --output` default `strip.png` `cli.rs:146-159` |
| `onion <RANGE>` | `-n, --count` default 6; `-o, --output` default `onion.png` `cli.rs:163-169` |
| `svg <AT>` | `-o, --output` (else stdout) `cli.rs:173-178` |
| `timeline` | (no args) `cli.rs:90` |
| `inspect [RANGE]` | `--every` default `0.25s`; `--all-frames`; `--info`; `--fail-on error|warning|never` default `error` (exit code 2) `cli.rs:187-203` |
| `snapshot <AT...>` | `--dir` default `_frame_snapshots`; `--update`; `--threshold` default 16; `--max-diff` default 0.001 `cli.rs:205-221` |
| `audio render [RANGE]` | `-o, --output` default `audio.wav`; `--float` (32-bit) `cli.rs:224-232` |
| `audio analyze [RANGE]` | `--waveform <png>` (LUFS, true peak, clipping, silence) `cli.rs:234-240` |
| `audio at <AT...>` | required, comma-delimited `cli.rs:241-245` |
| `preview [AT]` | `at` default `start`; `--paused`; `--no-loop`; `--mute`; `--backend auto|metal|vulkan|cpu` `cli.rs:102-119` |

**Time-spec grammar** (`TIME_SPECS`, `cli.rs:33-41`):
```
120, 120f        frame 120               3.2s, 500ms, 1:05.5   a timestamp
50%              half of the video       start, end            first / last frame
Intro            first frame of a scene (case-insensitive)   #3   scene index 3
Intro[1]         second scene of type Intro
Intro@1.2s       1.2s into the scene (also @12, @50%, @end)
RANGES: a..b (end exclusive), a.., ..b, all, or a scene name for the whole scene.
```

---

## SKILL.md workflow summary — `skills/fframes-video/SKILL.md`

The repo ships an agent skill (`skills/fframes-video/SKILL.md` + `references/{api,audio,design}.md`).
Installed via `npx skills add https://fframes.studio`. Full workflow:

1. **Install** — Rust + system libs ffmpeg is built with (Debian: `nasm yasm ffmpeg libx264-dev
   libx265-dev libopus-dev libclang-dev clang ninja-build libvpx-dev libasound2-dev`).
2. **Create** — `cargo install --locked cargo-fframes` then
   `cargo fframes new my-video --format landscape --fps 30 --yes`. Always pass `--yes`.
   Templates: `single-scene` (default, any format) / `multi-scene` (two scenes, 16:9).
   **Default backend is Skia GPU** (`skia-metal` on macOS, `skia-vulkan` on Linux/Win; `--backend cpu`
   when no GPU — no preview window, ~10x slower). Start `cargo build --release` in the background
   immediately (first build is the slow one).
3. **The loop** (after every change), `R() { cargo run --release -- "$@"; }`:
   - `$R timeline` — scenes, frame/second ranges, audio tracks + mix. Check structure/pacing first.
   - `$R inspect` — checks a frame every 0.25 s + first/last of every scene; reports missing
     images/fonts/glyphs, clipped text, invalid SVG, broken transforms, panics; **exit code 2** on error.
   - `$R strip <scene|range> -n 12` → `strip.png` contact sheet ("fastest way to judge layout, rhythm, motion").
   - `$R frame Intro@end,Outro@50%` → full-size PNGs into `frames/`.
   - `$R onion "Intro@0..Intro@1s" -n 6` → `onion.png` (trajectory + easing).
   - `$R preview Intro` — real-time window with sound (space play/pause, h/l seek, j/k step frame, q quit); blocks.
   - `$R render Intro --draft` (~1 s) → `$R render` writes `out.mp4`.
   - Rules: look at PNGs before judging; prefer `strip`; `--json` for parsing; keep `--release`;
     `cargo test` compares approved `_frame_snapshots/*.png` (`FFRAMES_UPDATE_SNAPSHOTS=1` to accept).
4. **Writing the video** — one scene per idea, 2-6 s each; animate with
   `frame.animate(&timeline!(at 0.2 => 0.8, animate 0.0_f32 => 1.0, Easing::EaseOut))` and springs;
   keep static markup literal (compile-time cached), put animated values on a wrapping `<g>`;
   `render_frame` runs multithreaded → no panics/IO; fonts by family name from `media/`;
   measure text with `frame.text_width/text_fit/text_break_lines`; GPU shaders via `fframes::Shader`.
5. **Design** (short form of `references/design.md`) — one idea/scene, large type, 8-10% margins,
   2-3 colors + accent; enter 300-600 ms ease-out/spring, leave 200-300 ms ease-in, stagger 60-120 ms;
   give 1-2 s to read after motion settles; cross-fade with `Overlap::Previous(0.4)`.
6. **Sound** — `AudioMap::from([AudioTrack::new("music.mp3", Second(0.)..Eof).gain_db(-18.)
   .fade_in(1.).fade_out(2.).duck_under_voice(), AudioTrack::new("vo.wav", Second(0.6)..Eof).voice()])`;
   target ≈ −14 LUFS integrated, true peak < −1 dBTP.
7. **Finish** — `inspect --fail-on warning` passes; strips reviewed; `audio analyze` sane;
   `render -o out.mp4`; confirm with
   `ffprobe -v error -show_entries stream=codec_type,width,height,nb_frames,duration out.mp4`.

Browser WASM editor exists (`examples/hello-world/editor`, needs Node + wasm-pack) — mention only on request.

---

## Dependency / backend matrix

Read from the Cargo.toml files. **Skia is NOT required by the core `fframes` crate.**

### Rasterization backends

| crate | backend | native deps | status |
|---|---|---|---|
| `fframes` (default feature `cpu_renderer = ["svgr"]`) | **CPU, pure Rust** via `usvgr`/`svgr` (tiny-skia) | none beyond Rust | **the default**; `AGENTS.md:14` "built-in CPU backend (tiny-skia)"; multi-threaded, ~10x slower than GPU |
| `fframes_skia_renderer` (`fframes-skia-renderer/Cargo.toml`) | GPU: Metal / Vulkan (+ Skia CPU) | `skia-safe 0.153.3` (prebuilt download for macOS/Linux gnu/arm64, else built from source ~20 min, needs libclang) | **separate optional crate**, not a dependency of `fframes`; needed for `Shader`/SkSL/Shadertoy and `preview` |
| `fframes-lyon-renderer` (`fframes-lyon-renderer/Cargo.toml`) | POC pure-Rust backend on `lyon` + `wgpu` 23 | GPU (wgpu) | **abandoned stub**: `src/lib.rs` is 73 bytes; **commented out of the workspace** (`Cargo.toml:47-48` "# maybe clean this up?"). Not an alternative. |

`fframes/Cargo.toml:60-68`:
```toml
default = ["cpu_renderer"]
cpu_renderer = ["svgr"]
cli = ["cpu_renderer", "dep:clap", "dep:serde_json"]
compile-time-svgtree = ["svgr-macro/compile-time-svgtree"]   # required by Skia backend and Shader
```

### FFmpeg linkage

- `fframes` → `fframes-media` → **`ffmpeg-sys-fframes` 9.0.0** (`Cargo.toml:104`,
  `fframes-media/Cargo.toml:45-46` with `features = ["build","static"]`). This crate is a fork of
  `zmwangx/rust-ffmpeg-sys` / `ffmpeg-sys-next` (upstream is **WTFPL**), renamed/republished by
  dmtrKovalenko. It provides the FFI bindings (`ffmpeg-sys-fframes` re-exported as
  `fframes::ffmpeg_sys_fframes`, `fframes/src/lib.rs:167-168`).
- FFmpeg is statically linked. It first tries a **prebuilt archive**; if none matches the target +
  feature key it **`git clone`s FFmpeg from github.com and compiles from source**
  (`build_prebuilt.rs:30-31`, `build.rs:1131-1136`). Codec features additionally need the codec
  `-dev` packages (libx264/x265/opus/vpx) at build time.
- **System libs required at build time** (when compiling from source): `git`, `curl`, `pkg-config`,
  `clang`/`libclang` (bindgen), `cc`, `make`; `nasm`/`yasm` for x86 SIMD (not needed on arm64);
  and the codec dev packages for the enabled codec features (README `SKILL.md:29-38`).

### Feature flags that gate codecs / hardware — `fframes/Cargo.toml:74-92`

```toml
h264 = ["fframes-media/h264"]      # → ffmpeg-sys-fframes/build-lib-x264   (needs libx264-dev)
h265 = [.../build-lib-x265]        aac = [.../build-lib-aacplus]
mp3lame = [.../build-lib-mp3lame]  opus = [.../build-lib-opus]   vpx = [.../build-lib-vpx]
videotoolbox audiotoolbox vaapi nvidia qsv vulkan mediacodec      # HW accel → ffmpeg build-*
libav-agree-gpl      = ["fframes-media/libav-agree-gpl"]          # → build-license-gpl
libav-agree-nonfree  = ["fframes-media/libav-agree-nonfree"]
libav-agree-version3 = ["fframes-media/libav-agree-version3"]
build-portable = [...]             # omit -march=native (avoids SIGILL on cached/cross-CPU builds)
exif = [...]                       # EXIF orientation of loaded images
```
`--locked`/`Cargo.lock` note: none of the fetched manifests pin an exact FFmpeg; the version is
`9.0.0`.

---

## Feasibility evidence (raw output)

Artifacts under `/data/data/com.termux/files/usr/tmp/fframes-work/`.

### 1. `cargo install --locked cargo-fframes` — SUCCEEDS

```
    Updating crates.io index
  Downloaded cargo-fframes v1.1.0
    Updating crates.io index
   Compiling clap v4.5.36
   Compiling dialoguer v0.11.0
   Compiling cargo-fframes v1.1.0
    Finished `release` profile [optimized] target(s) in 2m 41s
  Installing /data/data/com.termux/files/home/.cargo/bin/cargo-fframes
   Installed package `cargo-fframes v1.1.0` (executable `cargo-fframes`)
INSTALL_EXIT=0
```
(`~/.cargo/bin/cargo-fframes`, 1,471,760 bytes. Note: `~/.cargo/bin` is not on PATH by default.)

### 2. Minimal fframes video for `aarch64-linux-android` — FAILS

`cargo build` of a crate with `fframes = "1.1.0"` (`fframes-probe/`) timed out after 540 s still
downloading the dependency tree (`BUILD_EXIT=124`) — the crates.io sparse index is very slow here,
but downloads do work. To reach the real failure deterministically I built `ffmpeg-sys-fframes 9.0.0`
alone (`probe2/`), the crate `fframes-media` pulls:

```
  cargo:rustc-link-search=native=.../out/dist/lib
  cargo:rustc-link-lib=static=avcodec  (…avdevice avfilter avformat avutil swresample swscale…)
  No prebuilt FFmpeg binaries at https://github.com/dmtrKovalenko/rust-ffmpeg-sys/releases/download/binaries-9.0.0/ffmpeg-aarch64-linux-android-avcodec-avdevice-avfilter-avformat-swresample-swscale.tar.gz ("curl" "--fail" "--location" "--silent" "--show-error" "--retry" "3" ...) failed: curl: (22) The requested URL returned error: 404), compiling from source

  --- stderr
  Cloning into 'ffmpeg-9.0'...
  fatal: unable to access 'https://127.0.0.1:1/': Failed to connect to 127.0.0.1:1 after 0 ms: Could not connect to server

  thread 'main' (8153) panicked at .../ffmpeg-sys-fframes-9.0.0/build.rs:1134:25:
  called `Result::unwrap()` on an `Err` value: Custom { kind: Other, error: "fetch failed" }
BUILD2B_EXIT=101
```
(`https://127.0.0.1:1/` was an **instrumented** git `insteadOf` so the internal `git clone` fails
instantly instead of hanging; the 404 is the crate's own real HTTP result.)

**The exact source lines (`build.rs:1131-1136`) that decide this:**
```rust
if fs::metadata(search().join("lib").join("libavutil.a")).is_err() {
    fs::create_dir_all(output()).expect("failed to create build directory");
    if !(statik && prebuilt::try_install(&search())) {   // 404 → false
        fetch().unwrap();                                 // build.rs:1134 → git clone FFmpeg → panic
        build(sysroot.as_deref()).unwrap();
        ...
    }
}
```
`fetch()` is literally (`build.rs:160-177`):
```rust
let status = Command::new("git")
    .arg("clone").arg("--depth=1").arg("-b").arg(format!("release/{}", version()))
    .arg("https://github.com/FFmpeg/FFmpeg").arg(&clone_dest_dir)
    .status()?;
```

**3. That clone does not work here** — the exact call, timed:
```
$ GIT_TERMINAL_PROMPT=0 timeout 45 git clone --depth=1 -b release/9.0 https://github.com/FFmpeg/FFmpeg ffmpeg-clone-test
Cloning into 'ffmpeg-clone-test'...
git clone exit=124
(interrupted by timeout; directory contains only .git, no objects)
```

**4. Prebuilt coverage is 4 triples only** (`.github/workflows/binaries.yml:41-45`):
`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`.
**No `aarch64-linux-android`** → guaranteed 404 on Termux.

**5. Even with a working clone, the Android path needs the NDK** — `build.rs`:
```rust
// build.rs:273-274
let sysroot_path = env::var("CARGO_NDK_SYSROOT_PATH")
    .expect("Missing android sysroot path. For android cross compilation please use cargo-ndk …");
// build.rs:477-482
let android_cc_raw_path = env::var(format!("CC_{target}"))
    .expect("Missing CC path for android. Make sure to use cargo-ndk for android cross compilation");
```
So the supported way to get fframes for Android is **cross-compiling from a desktop with
cargo-ndk**, not building natively inside Termux.

**6. Skia is not the blocker here.** The core `fframes` default build never pulls `skia-safe`
(see matrix). The Skia path is only needed for GPU preview/shaders.

### 7. FALLBACK PATH — PROVEN TODAY (no fframes, no Skia, no FFmpeg build)

Generated 5 PNG frames with **pure Python stdlib** (zlib + struct, no PIL) and encoded with the
host ffmpeg:

```bash
# frame generation (python stdlib PNG writer) → /…/fframes-work/fallback/frames/img_000..004.png
# (script in the transcript; each frame 640x360, ~100 KB)
ls -la fallback/frames/        # img_000.png … img_004.png, 100653–101050 bytes each

ffmpeg -y -hide_banner -loglevel error -framerate 5 -i frames/img_%03d.png \
       -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart out.mp4
# ENCODE_EXIT=0
$ ls -la out.mp4
-rw-------. 1 u0_a419 u0_a419 9543 Oct  3 21:46 out.mp4
$ ffprobe -v error -show_entries stream=codec_name,codec_type,width,height,nb_frames,r_frame_rate,duration \
          -show_entries format=duration,size,format_name -of default=noprint_wrappers=1 out.mp4
codec_name=h264
codec_type=video
width=640
height=360
r_frame_rate=5/1
duration=1.000000
nb_frames=5
format_name=mov,mp4,m4a,3gp,3g2,mj2
duration=1.000000
size=9543
```
Host ffmpeg 8.1.2 exposes `libx264`, `libx264rgb`, `libx265`, `mpeg4`, `aac` encoders
(`ffmpeg -encoders`), so H.264/H.265/AAC muxing to mp4 is available without any FFmpeg build.

---

## RECOMMENDED render path (works on this host today)

**Authored-SVG → rasterize → ffmpeg.** Because fframes cannot link, keep fframes' *authoring model*
(one SVG string per frame, driven by a per-frame time value) but rasterize outside fframes:

1. For each frame `i` at `fps`, produce an SVG string (mirroring fframes' `svgr!` output; you can reuse
   the fframes API knowledge in this doc for transforms, easing math and the time-spec grammar).
2. Rasterize SVG → PNG with any available renderer. Available/known on this host:
   - **`resvg` / `tiny-skia`** (pure Rust; a peer agent is building exactly this in `~/rstest` —
     `resvg::usvg::Tree::from_str` → `tiny_skia::Pixmap` → `encode_png`). This is the closest
     fframes-equivalent (same `usvgr`/tiny-skia family as fframes' CPU backend).
   - `chromium-browser` is present (`/data/data/com.termux/files/usr/bin/chromium-browser`) for
     headless SVG/HTML→PNG (not verified here).
   - No `rsvg-convert`, ImageMagick, cairosvg or PIL were found.
3. Encode the PNG sequence with the **host ffmpeg** (libx264).

**Exact smoke command that produced a video file** (the proven, dependency-free fallback; PNGs from
step 1/2 replace the Python frames):
```bash
ffmpeg -y -hide_banner -loglevel error -framerate 5 -i frames/img_%03d.png \
       -c:v libx264 -pix_fmt yuv420p -crf 23 -movflags +faststart out.mp4
```
Output: `/data/data/com.termux/files/usr/tmp/fframes-work/fallback/out.mp4`
```
-rw-------. 1 u0_a419 u0_a419 9543 Oct  3 21:46 out.mp4
```
`ffprobe` → `h264 640x360 5 frames 1.000s` (full output in Feasibility §7).

For audio, fframes' `AudioMap` semantics (gain_db, fades, ducking, EOFS) can be reproduced with
ffmpeg's `amix`/`volume`/`afade`/`sidechaincompress`, or `-f concat`; not tested here.

---

## Risks / what will not work here

1. **`fframes` / `cargo install`-ing the library: NO.** Blocked at `ffmpeg-sys-fframes` —
   no `aarch64-linux-android` prebuilt (404) and the FFmpeg-source `git clone` from github.com does
   not complete (exit 124). Do not spend build budget here.
2. **Even with network fixed, native Android build needs the NDK** (`CC_<triple>`,
   `CARGO_NDK_SYSROOT_PATH`) — it is a cargo-ndk *cross* path, not a Termux-native path.
3. **Skia GPU backend / `Shader` (SkSL/Shadertoy) / `preview` window: NO** — no Vulkan/Metal on this
   host and `skia-safe` needs prebuilt-or-libclang+long source build. The CPU backend cannot run
   shaders.
4. **`fframes-lyon-renderer` is not a workaround** — it is a 73-byte stub, commented out of the
   workspace, and targets wgpu GPUs anyway.
5. **`cargo fframes new` scaffold will generate projects that still cannot build here** (its
   `Cargo.toml` pulls fframes + `h264`/`libav-agree-gpl`). The scaffolder installing OK does **not**
   mean the generated project compiles.
6. **Network fragility is the meta-risk.** Direct github.com is reset; a mirror (`gh-proxy.com`) is
   required for git/raw. crates.io downloads work but the sparse-index resolution for fframes' large
   tree is slow (>9 min, hit the timeout). Expect `cargo` to be network-bound.
7. **Concurrency hazard observed:** two simultaneous `cargo build`s caused
   `error: failed to run custom build command for proc-macro2 … Text file busy (os error 26)`.
   Run one cargo build at a time.
8. **Redistribution / licensing.** Repo `LICENSE.txt` is **MIT** ("Copyright (c) 2025-2026 Dmitriy
   Kovalenko"). But the generated project's Cargo.toml enables **`h264` + `libav-agree-gpl`** by
   default, and `libav-agree-gpl` maps to `ffmpeg-sys-fframes/build-license-gpl`; linking libx264
   makes the resulting **binary GPL-encumbered** (libx264 is GPLv2), and the FFmpeg static build is
   under the corresponding FFmpeg license. `ffmpeg-sys-next` upstream is WTFPL; `skia-safe`/Skia is
   BSD-3. If the opencc distribution must stay MIT, strip `libav-agree-gpl` and use a permissive
   encoder (e.g. `mpeg4`, or the host ffmpeg by subprocess) rather than the default scaffold features.
9. **`timeline!` is seconds-only** — a builder expecting `at 12f`/`at 50%` in the macro will fail to
   compile; those are CLI time specs. Animate by frames via `frame.frame_to_second(..)` +
   `animate_runtime`.
10. **`fframes` version pinning:** the scaffold pins `fframes = "=1.1.0"`; the workspace `Cargo.toml`
   also references a path dep `fframes-renderer` that **does not exist in the tree** (legacy; harmless
   unless a crate imports it).

### Source file index (fetched copies under `/…/fframes-work/files/`)
`fframes_src_video.rs`, `fframes_src_svgr.rs`, `fframes_src_frame.rs`,
`fframes_src_animation_animation.rs`, `fframes_src_scenes.rs`, `fframes_src_duration.rs`,
`fframes_src_audio_map.rs`, `fframes_src_shader.rs`, `fframes_src_time_spec.rs`, `fframes_src_lib.rs`,
`fframes_src_renderer_cli.rs`, `fframes_Cargo.toml`, `Cargo.toml`, `fframes-media_Cargo.toml`,
`fframes-lyon-renderer_Cargo.toml`, `fframes-skia-renderer_Cargo.toml`, `svgr-macro_Cargo.toml`,
`svgr-macro_src_lib.rs`, `cargo-fframes_src_main.rs`, `skills_fframes-video_SKILL.md`,
`skills_fframes-video_references_{api,audio,design}.md`, `LICENSE.txt`, `AGENTS.md`,
`sys_build.rs` / `sys_Cargo.toml` (the `ffmpeg-sys-fframes` fork). Full clone was attempted via the
`gh-proxy.com` mirror; it stalled, so files were read from the mirror + jsdelivr at rev `bae393f`.
