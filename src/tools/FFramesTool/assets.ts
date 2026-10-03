/**
 * Bundled asset registry for the FFramesTool.
 *
 * Every file under ./assets/ is imported as inline text via Bun's
 * `with { type: 'text' }` import attribute. At build time the bundler inlines
 * each file's contents as a string constant, so the tool carries its own
 * knowledge base and scaffold templates inside the single-file bundle with no
 * runtime dependency on any external path.
 *
 * Layout:
 *   assets/SKILL.md                        the fframes-video skill guide
 *   assets/references/api.md               fframes API cheat sheet
 *   assets/references/audio.md             audio reference
 *   assets/references/design.md            design reference
 *   assets/references/rust-core-api.md     extracted Rust core API (with source citations)
 *   assets/templates/*.tmpl                real `cargo fframes new` scaffold templates
 *   assets/fonts/DMSans-Medium.ttf         font used by the scaffold and the render smoke path
 *
 * The reference docs (api/audio/design) and SKILL.md are verbatim copies of
 * github.com/dmtrKovalenko/fframes (branch main), skills/fframes-video/. The
 * templates are verbatim copies of cargo-fframes/templates/. Provenance is the
 * upstream repository; nothing here is hand-written fframes documentation.
 *
 * To add a new reference: drop the file under ./assets/references/ and add a
 * matching import + entry below. The FFramesTool.ts action handlers read from
 * these arrays exclusively.
 */

// --- Main guide ---
import skillMd from './assets/SKILL.md' with { type: 'text' }

// --- Reference documents (canonical order; the tool's `reference` action
// validates against this list, so adding here is what exposes it to the model) ---
import refApi from './assets/references/api.md' with { type: 'text' }
import refAudio from './assets/references/audio.md' with { type: 'text' }
import refDesign from './assets/references/design.md' with { type: 'text' }
import refRustCoreApi from './assets/references/rust-core-api.md' with { type: 'text' }

// --- Real `cargo fframes new` scaffold templates (verbatim from cargo-fframes/templates/).
// The {{placeholder}} tokens are substituted by the `scaffold` action. ---
import tplCargoToml from './assets/templates/Cargo.toml.tmpl' with { type: 'text' }
import tplLibSingleScene from './assets/templates/lib_single_scene.rs.tmpl' with { type: 'text' }
import tplLibMultiScene from './assets/templates/lib_multi_scene.rs.tmpl' with { type: 'text' }
import tplMainCpu from './assets/templates/main_cpu.rs.tmpl' with { type: 'text' }
import tplReadme from './assets/templates/README.md.tmpl' with { type: 'text' }
import tplGitignore from './assets/templates/gitignore.tmpl' with { type: 'text' }
import tplFramesTest from './assets/templates/frames_test.rs.tmpl' with { type: 'text' }

export interface ReferenceAsset {
  /** Stable identifier (no .md suffix) used by the `reference` action. */
  name: string
  /** Logical asset path inside the tool directory — useful for attribution. */
  path: string
  /** Document body with YAML frontmatter stripped. */
  content: string
}

/**
 * Strip a leading YAML frontmatter block (---\n...\n---) so returned docs are
 * clean body text. Mirrors SkillTool's parseFrontmatter behavior.
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4).replace(/^\r?\n/, '')
}

const REFERENCES: ReferenceAsset[] = [
  {
    name: 'api',
    path: 'assets/references/api.md',
    content: stripFrontmatter(refApi),
  },
  {
    name: 'audio',
    path: 'assets/references/audio.md',
    content: stripFrontmatter(refAudio),
  },
  {
    name: 'design',
    path: 'assets/references/design.md',
    content: stripFrontmatter(refDesign),
  },
  {
    name: 'rust-core-api',
    path: 'assets/references/rust-core-api.md',
    content: stripFrontmatter(refRustCoreApi),
  },
]

/** Main guide body (frontmatter stripped). */
export const GUIDE: string = stripFrontmatter(skillMd)

/** Logical path of the main guide, for attribution. */
export const GUIDE_PATH = 'assets/SKILL.md'

export function getReference(name: string): ReferenceAsset | undefined {
  const trimmed = name.trim().replace(/\.md$/i, '')
  return REFERENCES.find(r => r.name === trimmed)
}

export function listReferences(): ReadonlyArray<ReferenceAsset> {
  return REFERENCES
}

// --- Scaffold templates ---------------------------------------------------

export type TemplateName = 'single-scene' | 'multi-scene'

export interface TemplateAsset {
  /** Logical asset path inside the tool directory. */
  path: string
  /** Raw template body with the `{{placeholder}}` tokens left unreplaced. */
  content: string
}

const TEMPLATES: Record<string, TemplateAsset> = {
  'Cargo.toml': { path: 'assets/templates/Cargo.toml.tmpl', content: tplCargoToml },
  'lib_single_scene.rs': {
    path: 'assets/templates/lib_single_scene.rs.tmpl',
    content: tplLibSingleScene,
  },
  'lib_multi_scene.rs': {
    path: 'assets/templates/lib_multi_scene.rs.tmpl',
    content: tplLibMultiScene,
  },
  'main_cpu.rs': { path: 'assets/templates/main_cpu.rs.tmpl', content: tplMainCpu },
  'README.md': { path: 'assets/templates/README.md.tmpl', content: tplReadme },
  'gitignore': { path: 'assets/templates/gitignore.tmpl', content: tplGitignore },
  'frames_test.rs': { path: 'assets/templates/frames_test.rs.tmpl', content: tplFramesTest },
}

export function getTemplate(name: string): TemplateAsset | undefined {
  return TEMPLATES[name]
}

export function listTemplates(): ReadonlyArray<{ name: string; path: string }> {
  return Object.entries(TEMPLATES).map(([name, t]) => ({ name, path: t.path }))
}

/**
 * Render a template by replacing `{{key}}` tokens. Mirrors `render()` in
 * cargo-fframes/src/main.rs (literal `{{key}}` → value replacement, repeated
 * until no token remains).
 */
export function renderTemplate(content: string, vars: Record<string, string>): string {
  let out = content
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value)
  }
  return out
}

/** Physical path (inside the tool dir) of the bundled scaffold font. */
export const FONT_FILE = 'assets/fonts/DMSans-Medium.ttf'
