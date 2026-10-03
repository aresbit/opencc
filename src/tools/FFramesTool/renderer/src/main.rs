//! Minimal SVG -> PNG rasteriser used by the FFramesTool `render` action.
//!
//! CLI (identical to ~/rstest, plus an optional font):
//!   fframes-render <in.svg> <out.png> <size> [font.ttf]
//!   fframes-render - - <size> [font.ttf]      (SVG on stdin, PNG on stdout)
//!
//! `size` is the output edge length in pixels (square pixmap). The SVG is scaled
//! to fill it. A font file may be passed as the 4th argument (or FFRAMES_FONT);
//! without it, system fonts are loaded, but note that a font must be registered
//! for `<text>` to rasterise at all — resvg drops text when no font matches.

use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (svg_path, png_path, size) = if args.len() >= 4 {
        (
            args[1].clone(),
            args[2].clone(),
            args[3].parse::<u32>().unwrap_or(640),
        )
    } else {
        ("-".into(), "-".into(), 640)
    };
    let font = args
        .get(4)
        .cloned()
        .or_else(|| std::env::var("FFRAMES_FONT").ok());

    let svg = if svg_path == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).unwrap();
        s
    } else {
        std::fs::read_to_string(&svg_path).unwrap()
    };

    let mut opt = resvg::usvg::Options::default();
    {
        let db = opt.fontdb_mut();
        if let Some(path) = font.as_deref() {
            if !path.is_empty() {
                let _ = db.load_font_file(path);
            }
        }
        db.load_system_fonts();
    }
    if font.is_some() {
        opt.font_family =
            std::env::var("FFRAMES_FONT_FAMILY").unwrap_or_else(|_| "DM Sans".to_owned());
    }

    let tree = resvg::usvg::Tree::from_str(&svg, &opt).expect("parse svg");
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size, size).unwrap();
    let ts = resvg::tiny_skia::Transform::from_scale(
        size as f32 / tree.size().width(),
        size as f32 / tree.size().height(),
    );
    resvg::render(&tree, ts, &mut pixmap.as_mut());
    let png = pixmap.encode_png().unwrap();
    if png_path == "-" {
        std::io::stdout().write_all(&png).unwrap();
    } else {
        std::fs::write(&png_path, &png).unwrap();
    }
    eprintln!("wrote {} bytes to {}", png.len(), png_path);
}
