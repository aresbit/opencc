# fframes Rust core API (extracted)

Real signatures and excerpts extracted from the fframes source checkout at
`github.com/dmtrKovalenko/fframes` (branch `main`). Every excerpt below is quoted
verbatim from the local source tree and cites the source file it came from. Nothing
here is paraphrased or invented: if a type is not listed, it was not read from source.

Source root for all paths below:
`/data/data/com.termux/files/home/fframes-src/`

---

## 1. The render pipeline (5 steps)

Source: `fframes/src/lib.rs` (crate-level docs, lines 6-24).

> # Pipeline
>
> 1. `Video::duration`, `Video::define_scenes` and `Video::audio` are resolved into a frame
>    timeline once per render. Scenes (`Scene`, `Scenes`, `Overlap`) are placed back to back,
>    audio tracks (`AudioMap`, `AudioTrack`) are placed at their sample position.
> 2. For every frame the renderer builds a `Frame` (index, time, scene offset) and a
>    `FFramesContext` (media lookups, scene info, video size) and calls
>    `Video::render_frame`. Frames are rendered concurrently, so the method must be pure: read
>    precomputed data from `self`, no I/O, no panics.
> 3. The returned `Svgr` becomes a `usvgr::Tree`. With the `compile-time-svgtree` feature the
>    macro emits the tree at compile time and every subtree without `{}` interpolation carries a
>    static hash, which lets the backends cache its rasterisation across frames. Without the
>    feature the markup is a string parsed per frame.
> 4. A rendering backend (`FFramesRenderBackend`) rasterises the tree. The built-in
>    `cpu::CpuRenderingBackend` renders one video segment per thread with tiny-skia. The Skia
>    backend in the `fframes_skia_renderer` crate walks the tree on the GPU and also executes
>    `Shader` layers.
> 5. Segments are encoded through `FFmpeg` (`EncoderOptions`), concatenated, and muxed with the
>    audio mix (`AudioMixOptions`: summing, ducking, fades, master limiter).

The crate doc also lists the feature flags that gate 3 and 4:

> - `cpu_renderer` (default): the tiny-skia based `cpu::CpuRenderingBackend` and the encoding
>   pipeline. Disable it for a `wasm32` build.
> - `compile-time-svgtree`: `svgr!` builds the SVG tree at compile time and hashes static
>   subtrees. Required by the Skia backend and by `Shader`.

---

## 2. The `Video` trait

Source: `fframes/src/video.rs` (lines 10-80).

```rust
/// The base fframes video trait. It represents how to render a video for a struct which becomes an
/// input of the video.
pub trait Video: Sync + Sized {
    const FPS: usize;
    const WIDTH: usize;
    const HEIGHT: usize;

    /// Background color of the video. This allows to set a solid color background.
    ///
    /// Make sure if you want to render a transparent video use `Color::TRANSPARENT` here
    /// **and** set the proper encoder and `pixel_format` that supports transparency
    /// (e.g. encoder libx265 with yuva420p pixel format) when rendering the video.
    const BACKGROUND_COLOR: Color = Color::BLACK;

    /// Defines either dynamic or inferred duration of the video
    fn duration(&self) -> Duration<'_>;

    /// Defines the audio timeline of the video (when and how long audio tracks are played)
    fn audio(&self) -> AudioMap<'_>;

    /// Defines the scenes timeline of the video.
    /// Each scene is an dyn object which implements the `Scene` trait.
    ///
    /// Every scene must be either bound to the `&self` lifetime or be a zero sized type.
    /// In short: put your scenes to the `&self` or do not add any fields to the scene struct.
    fn define_scenes(&self) -> Scenes<'_> {
        Scenes(None)
    }

    /// This function is going to be called for each frame of the video and expects to return
    /// a valid SVG rendering tree for the specific frame.
    ///
    /// This function is going to be called thousands of times per rendering, so it is important to reduce
    /// amount of allocations and cpu bound operations happening during the render frame. It is
    /// possible to cache the data in the `self` and use it in the function or to memoize the data
    /// in `self` using `once_cell::LazyLock` or similar constructs.
    ///
    /// **Tip:** Avoid panicking in this function as much as possible, this function does not
    /// return `Result` because it is extremely expensive to stop the rendering once it has
    /// started. Prepare compiler guaranteed data in advance and read it from `self`.
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a>;
}
```

Key points, from the same file:

- The three associated consts are `FPS`, `WIDTH`, `HEIGHT`; `BACKGROUND_COLOR` is a fourth with
  a default of `Color::BLACK`.
- `duration()`, `audio()`, `define_scenes()` are `&self` methods; `define_scenes()` defaults to
  `Scenes(None)` (no scene timeline).
- `render_frame(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a>` returns the
  SVG tree for that frame. It is `&'a self` and must be pure (called concurrently).

---

## 3. The `svgr!` macro

Source: `svgr-macro/src/lib.rs` (the proc-macro entry point, lines 82-111).

```rust
#[proc_macro]
pub fn svgr(tokens: TokenStream) -> TokenStream {
    let fframes_crate_ident = match proc_macro_crate::crate_name("fframes")
        .expect("fframes crate must be present in Cargo.toml")
    {
        proc_macro_crate::FoundCrate::Itself => Ident::new("crate", Span::call_site()),
        proc_macro_crate::FoundCrate::Name(name) => Ident::new(&name, Span::call_site()),
    };

    let parse_result =
        parse(tokens, &fframes_crate_ident).and_then(|ParseOutput { nodes, animations }| {
            let svgr_ident = create_svgr_ident(&fframes_crate_ident, nodes)?;

            Ok(quote! {{
                 use #fframes_crate_ident::usvgr::svgtree::macro_prelude::*;

                 #fframes_crate_ident::lazy_static::lazy_static! { #(#animations)* }

                 #[allow(unused_braces)]
                 #[allow(clippy::approx_constant)]
                 #svgr_ident
            }})
        });

    match parse_result {
        Ok(tokens) => tokens,
        Err(err) => err.to_compile_error(),
    }
    .into()
}
```

The macro emits a `fframes::Svgr`. With the `compile-time-svgtree` feature it fills the
`svg_tree` field; without it, it fills a `value: format!(...)` string (Source:
`svgr-macro/src/lib.rs` lines 33-70, `create_svgr_ident`).

Usage — Rust values are interpolated in braces. Source: `fframes/src/lib.rs` (minimal-video doc
example, lines 56-64):

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

The bundled `api.md` cheat sheet (`skills/fframes-video/references/api.md`) states the accepted
child/attribute kinds:

> SVG markup with Rust in braces. Attributes and text children take strings, numbers, `Color`,
> `Transform`, another `Svgr`, or a `Vec<Svgr>` / iterator collected to a `Vec`.

> - Literal text children are quoted strings. `Svgr::empty()` renders nothing.
> - Subtrees without `{}` are hashed at compile time and cached by the renderers: keep static
>   decoration static, wrap animated values around it.

---

## 4. The `timeline!` macro

Source: `fframes/src/animation/animation.rs` (lines 272-301).

```rust
#[macro_export]
macro_rules! timeline {
    ($(at $start:expr $(=> $end:expr)?, animate $from:expr => $to:expr, $easing:expr),+ $(,)?) => {
        fframes::animation::KeyFramesAnimation::new(vec![
            $(
                fframes::animation::KeyFrame {
                    start: $start,
                    end: $crate::option_literal!($($end)?),
                    from: $from,
                    to: $to,
                    easing: &$easing,
                },
            )+
        ])
    };

    ($(at $start:expr $(, duration $duration:expr)?, animate $from:expr => $to:expr, $easing:expr),+ $(,)?) => {
        fframes::animation::KeyFramesAnimation::new(vec![
            $(
                fframes::animation::KeyFrame {
                    start: $start,
                    end: $crate::option_duration!($start, $($duration)?),
                    from: $from,
                    to: $to,
                    easing: &$easing,
                },
            )+
        ])
    };
}
```

Two forms are accepted:

- `at <start> => <end>, animate <from> => <to>, <easing>` — explicit end time.
- `at <start>, duration <len>, animate <from> => <to>, <easing>` — end computed as
  `start + len` (via `option_duration!`).

The `KeyFrame` struct it builds (Source: `fframes/src/animation/animation.rs` lines 98-107):

```rust
#[derive(Clone, Copy, Debug)]
pub struct KeyFrame<'a, T: Animatable> {
    /// Start time of the keyframe in seconds
    pub start: f32,
    /// End time of the keyframe in seconds, it is going to be used as an easing duration if specified leaving the time before the next keyframe as a static value.
    pub end: Option<f32>,
    pub to: T,
    pub from: T,
    pub easing: &'a Easing,
}
```

The `Easing` enum (Source: same file, lines 70-96):

```rust
/// animation easing. Different variants of how value changes over time.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub enum Easing {
    /// Specifies an animation with the same speed from start to end.
    /// calculates as Linear(duration): `f(current_time)` = `current_time` / duration
    Linear,
    /// CSS-like ease-in easing function.
    /// Specifies an animation with a slow start.
    EaseIn,
    /// CSS-like ease-out easing function.
    /// Specifies an animation with a slow start and end, and faster in the middle.
    EaseOut,
    /// CSS-like ease-in-out easing function.
    /// Specifies an animation with a slow start and end, and faster in the middle.
    EaseInOut,
    /// CSS-like cubic-bezier easing function.
    /// Defines as a cubic-bezier(x1, y1, x2, y2) where x1, y1, x2, y2 are numbers in the range [0, 1].
    CubicBezier(f32, f32, f32, f32),
    // Inspired by https://webkit.org/demos/spring/spring.js. Copyright (C) 2016 Apple Inc. All rights reserved.
    /// Specifies an animation that calculates value based on spring physics.
    /// Learn more about spring physics: <https://www.joshwcomeau.com/animation/a-friendly-introduction-to-spring-physics/>
    Spring {
        mass: f32,
        stiffness: f32,
        damping: f32,
    },
}
```

Usage — the video's own doc example passes the macro to `frame.animate(...)` (Source:
`fframes/src/lib.rs` lines 53-55):

```rust
let opacity = frame.animate(&fframes::timeline!(
    at 0.0 => 0.5, animate 0.0_f32 => 1.0, Easing::EaseOut
));
```

---

## 5. `include_media_dir!`

Source: `media-dir-macro/src/lib.rs` (the proc-macro entry point, lines 13-24).

```rust
/// Embed the contents of a directory in your crate.
#[proc_macro]
pub fn include_media_dir(input: TokenStream) -> TokenStream {
    let fframes_crate_ident = resolve_fframes_crate_ident();

    let IncludeMediaDirInput {
        visibility,
        ident,
        path,
    } = parse_macro_input!(input as parser::IncludeMediaDirInput);

    let media_files = read_media_files_dir(&path);
```

The macro generates a struct whose fields are the media files in the directory, plus a
`prepare()` associated function. Usage (Source: `fframes/src/lib.rs` lines 31-32, and the
`main` in the same example at line 69):

```rust
// Every file in the folder becomes a field; fonts are registered by family name.
fframes::include_media_dir!(pub struct Media, "media");
```

```rust
let media = Media::prepare().expect("embedded media");
```

`MediaProvider` is the trait behind `prepare()` (Source: `fframes/src/media_provider.rs`
lines 20-53):

```rust
pub trait MediaProvider<'a>: Send + Sync + Debug {
    // ...
    fn prepare() -> Result<Self>;
}
```

---

## 6. `Scene` and `Scenes`

Source: `fframes/src/scenes.rs`.

The `Scene` trait (lines 46-66):

```rust
#[allow(unused_variables)]
pub trait Scene: Debug + Sync + Send {
    fn duration(&self) -> crate::Duration<'_>;
    fn render_frame<'a>(
        &'a self,
        frame: crate::Frame,
        ctx: &crate::FFramesContext<'a, '_>,
    ) -> Svgr<'a>;

    fn overlap(&self) -> Overlap {
        Overlap::None
    }

    fn audio(&self) -> crate::audio_map::AudioMap<'_> {
        crate::audio_map::AudioMap::none()
    }

    fn name(&self) -> &'static str {
        std::any::type_name::<Self>()
    }
}
```

The `Overlap` enum (lines 4-9):

```rust
pub enum Overlap {
    Previous(f32),
    Next(f32),
    PreviousAndNext { previous: f32, next: f32 },
    None,
}
```

`Scenes` and its constructors (lines 68-95):

```rust
#[derive(Debug, Clone)]
pub struct Scenes<'a>(pub(crate) Option<Vec<&'a (dyn Scene + 'a)>>);

impl Scenes<'_> {
    pub const fn empty() -> Self {
        Self(None)
    }

    pub fn len(&self) -> usize {
        self.0.as_ref().map_or(0, std::vec::Vec::len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<'a> From<Vec<&'a dyn Scene>> for Scenes<'a> {
    fn from(arr: Vec<&'a dyn Scene>) -> Self {
        Self(Some(arr))
    }
}

impl<'a, T: AsRef<dyn Scene + 'a>> From<&'a [T]> for Scenes<'a> {
    fn from(arr: &'a [T]) -> Self {
        Self(Some(arr.iter().map(std::convert::AsRef::as_ref).collect()))
    }
}
```

`SceneInfo`, the per-frame scene position object, lives in the same file (lines 29-44):

```rust
/// Represents current scene position and duration within a video.
pub struct SceneInfo {
    /// Resolved duration of scene in frames. The `frame.index` is always < `frame.scene_info.duration_in_frames`
    pub duration_in_frames: usize,
    /// The index of the scene in a video
    pub index: usize,
    /// The total amount of scenes in a video
    pub total_scenes_in_video: usize,
    /// If `true` then this scene is defined last in the video.
    pub is_last: bool,
    /// The start frame index of the scene
    pub start_frame: usize,
    /// The end frame index of the scene
    pub end_frame: usize,
}
```

---

## 7. Supporting types

`Duration` — Source: `fframes/src/duration.rs` (lines 9-20):

```rust
pub enum Duration<'a> {
    // ...
    FromAudio(&'a str),
    // ...
    FromVideo(&'a str),
    // ...
    Seconds(f32),
    // ...
    Frames(usize),
    // ...
    Auto,
}
```

`impl Add for Duration` is provided (same file, line 29), so `a + b` composes durations.
`Duration::to_frames`/`to_frames_async` resolve to a frame count against an fps
(`Duration::Seconds(seconds) => Ok((seconds * fps as f32) as usize)`).

`AudioMap::none()` — Source: `fframes/src/audio_map.rs` (lines 383, 426-429):

```rust
pub struct AudioMap<'a>(pub Option<Vec<AudioTrack<'a>>>);
```

```rust
impl<'a> AudioMap<'a> {
    pub fn none() -> Self {
        // ...
```

`Frame` — Source: `fframes/src/frame.rs` (lines 16-18) and the `animate` method (line 196):

```rust
pub struct Frame {
    pub index: usize,
    // ...
```

```rust
pub fn animate<T: crate::animation::Animatable + Copy + Default + std::fmt::Debug>(
```

`FFramesContext` — Source: `fframes/src/fframes_context.rs` (lines 21-22, 41, 86):

```rust
    pub width: usize,
    pub height: usize,
```

```rust
pub struct FFramesContext<'a, 'media: 'a> {
```

```rust
    pub fn get_image(&self, filename: impl AsRef<str>) -> Option<&'media ImageData<'media>> {
```

---

## 8. Minimal end-to-end example

Source: `fframes/src/lib.rs` (crate docs, lines 26-74). This is the canonical "minimal-video"
example that ties every piece above together:

```rust
use fframes::{AudioMap, Duration, FFramesContext, Frame, RenderOptions, Svgr, Video, animation::Easing};

// Every file in the folder becomes a field; fonts are registered by family name.
fframes::include_media_dir!(pub struct Media, "media");

struct Hello<'a> {
    media: &'a Media,
    title: &'a str,
}

impl Video for Hello<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;

    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(3.0)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let opacity = frame.animate(&fframes::timeline!(
            at 0.0 => 0.5, animate 0.0_f32 => 1.0, Easing::EaseOut
        ));
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"
                 width={Self::WIDTH} height={Self::HEIGHT}>
                <text x="120" y="560" font-family="DM Sans" font-size="150" fill="#fff"
                      opacity={opacity}>
                    "Hello " {self.title}
                </text>
            </svg>
        )
    }
}

fn main() -> std::process::ExitCode {
    let media = Media::prepare().expect("embedded media");
    let video = Hello { media: &media, title: "world" };
    // `render`, `frame`, `strip`, `inspect`, `snapshot`, `audio` and more (feature `cli`).
    fframes::cli::new(&video, RenderOptions { media: Some(&media), ..Default::default() }).run()
}
```
