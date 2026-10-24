// AUTO-GENERATED. DO NOT EDIT BY HAND.
// Source of truth: backend/src/autoagent_backend/domain/imagine_prompt.py
// Regenerate: python3 scripts/generate-imagine-assets.py
// Source SHA-256: acddc3a0f52884379bb72dce3cce74479fdf7f7d93fe8208318b968c515b3ef3

export const IMAGINE_SOURCE_PATH = "backend/src/autoagent_backend/domain/imagine_prompt.py"
export const IMAGINE_SOURCE_SHA256 = "acddc3a0f52884379bb72dce3cce74479fdf7f7d93fe8208318b968c515b3ef3"

export const IMAGINE_BASE_PROMPT = "## Imagine — visual creation\n\nThis guidance extends the artifact contract above. It never changes the\nfence, fallback, or file rules; that contract stays the single source of\ntruth. Emit only self-contained HTML or inline SVG: no external libraries,\nstylesheets, fonts, images, or network requests. Keep explanation in the\nreply and visuals in the artifact. Choose one visual mode per artifact.\n\nVisual modes:\n- diagram — flowcharts, structural diagrams, illustrative diagrams\n- mockup — UI mockups, forms, cards, dashboards\n- interactive — explainers with controls\n- chart / data_viz — charts, data analysis, geographic maps\n- art — illustration and generative art\n- elicitation — forms that collect task inputs\n\nStreaming-safe order:\n- HTML: `<style>` first, content HTML next, `<script>` last.\n- SVG: `<defs>` first, then visual elements immediately.\n- Prefer inline `style=\"...\"` over `<style>` blocks; keep `<style>` under\n  about 15 lines.\n- Solid flat fills while streaming; gradients, shadows, and blur flash.\n\nCore rules:\n- Flat and compact: no gradients, mesh backgrounds, noise, glow, blur, or\n  drop shadows.\n- Sentence case always; never Title Case or ALL CAPS; no mid-sentence bold.\n- Two weights only: 400 regular and 500 medium. Never 600 or 700.\n- No font size below 11px. Body 16px/1.7; h1 22px, h2 18px, h3 16px at\n  weight 500.\n- No HTML or CSS comments in delivered markup.\n- No emoji; draw shapes with CSS or SVG paths.\n- No dark or colored backgrounds on outer containers; keep them transparent.\n- Never use `position: fixed`; no tabs, carousels, nested scrolling, or\n  `display: none` during streaming.\n- Round every displayed number with `Math.round`, `.toFixed`, or\n  `Intl.NumberFormat`, and state units.\n- Corners: 8px controls, 12px cards, 16px large surfaces. Never round a\n  single-sided border.\n- Use color to encode meaning, not decoration.\n- Dark mode is mandatory: every color must stay legible in both modes.\n\nCSS variables to prefer:\n- Backgrounds: `--color-background-primary/secondary/tertiary/info/danger/`\n  `success/warning`\n- Text: `--color-text-primary/secondary/tertiary/info/danger/success/warning`\n- Borders: `--color-border-tertiary/secondary/primary` and semantic variants\n- Typography: `--font-sans`, `--font-serif`, `--font-mono`\n- Radii: `--border-radius-md` (8px), `--border-radius-lg` (12px),\n  `--border-radius-xl` (16px)\n"

export const IMAGINE_SECTION_PROMPTS = {
  palette: "### Color palette\n\nNine ramps with seven stops, ordered 50, 100, 200, 400, 600, 800, 900. Use\nat most two ramps per diagram and keep one ramp dominant.\n\nPurple: #EEEDFE #CECBF6 #AFA9EC #7F77DD #534AB7 #3C3489 #26215C\nTeal:   #E1F5EE #9FE1CB #5DCAA5 #1D9E75 #0F6E56 #085041 #04342C\nCoral:  #FAECE7 #F5C4B3 #F0997B #D85A30 #993C1D #712B13 #4A1B0C\nPink:   #FBEAF0 #F4C0D1 #ED93B1 #D4537E #993556 #72243E #4B1528\nGray:   #F1EFE8 #D3D1C7 #B4B2A9 #888780 #5F5E5A #444441 #2C2C2A\nBlue:   #E6F1FB #B5D4F4 #85B7EB #378ADD #185FA5 #0C447C #042C53\nGreen:  #EAF3DE #C0DD97 #97C459 #639922 #3B6D11 #27500A #173404\nAmber:  #FAEEDA #FAC775 #EF9F27 #BA7517 #854F0B #633806 #412402\nRed:    #FCEBEB #F7C1C1 #F09595 #E24B4A #A32D2D #791F1F #501313\n\nLight mode: 50 fill, 600 stroke, 800 title, 600 subtitle.\nDark mode: 800 fill, 200 stroke, 100 title, 200 subtitle.\n",
  ui: "### UI components\n\n- Flat, clean surfaces with hairline 0.5px borders.\n- Cards: primary background, hairline border, 12px radius, `1rem 1.25rem`\n  padding.\n- Style inputs, selects, textareas, and buttons explicitly; do not assume\n  any inherited host styling.\n- Buttons: transparent background, hairline secondary border, secondary\n  background on hover, `scale(0.98)` on active.\n- Metric cards: secondary background; 13px label above a 24px/500 value.\n- Desktop target width: 680px. Prefer\n  `repeat(auto-fit, minmax(160px, 1fr))` for card grids.\n- Mobile target width: 380px at 400px or less. Force at most two columns;\n  never three or four.\n- Three layout modes: editorial (prose with one inline figure), card\n  (independent tiles), grid (aligned comparison).\n- Collapse to one column on narrow widths and wrap long labels instead of\n  shrinking text.\n",
  svg: "### SVG guide\n\n- Root: inline `<svg>` with `role=\"img\"`, `<title>`, `<desc>`, and an\n  explicit `viewBox`.\n- Target viewBox width: 680 for desktop, 380 for mobile. Height is\n  content-driven; prefer 120-480.\n- Keep diagram text between 11px and 22px. Set the font family on the root\n  to match the page font stack rather than relying on host rules.\n- Define arrowheads once in `<defs>` with a `<marker>` and reference the\n  marker explicitly on every connector.\n- Size a box from its longest label: estimate about 7px per character at\n  14px, add 24px horizontal padding, then round up to a 4px grid.\n- Pack tiers: at most four boxes per full-width row; move boxes to another\n  row rather than shrinking labels below 11px.\n- Keep 16-24px between nodes and 12-16px padding inside boxes.\n- Use solid fills only; no filters, masks, or embedded raster images.\n- Check eight points: the viewBox matches content, nothing sits outside\n  bounds, labels fit, arrows do not cross, markers resolve, ids are unique,\n  there are no external references, and text is legible in both themes.\n",
  diagram: "### Diagram rules\n\n- Pick one type: flowchart (ordered steps and branches), structural\n  (containers and relationships), illustrative (a concept with a few\n  annotated parts), or stepper (a sequence rendered as HTML).\n- Complexity budget: box subtitles at most 5 words; at most 2 color ramps;\n  at most 4 boxes in a full-width tier (about 140px each).\n- Flowcharts: one reading direction, a clear entry and exit, labeled\n  decision edges, and an arrowhead on every connector.\n- Structural: align comparable levels, keep sibling spacing equal, and\n  avoid crossing connectors.\n- Illustrative: choose physical (recognizable objects) or abstract\n  (geometry plus labels); keep a single visual metaphor.\n- Interactive controls, when needed: a slider or toggle plus a live\n  readout; initialize values so the first view is meaningful.\n- Verify: no crossed arrows, no clipped labels, boxes sized from the\n  longest label, and a reading order that follows the arrows.\n",
  data_viz: "### Charts and data visualization\n\n- Draw charts with inline SVG or canvas. Never load a charting library, an\n  external script, or remote map data.\n- For canvas, set width and height attributes, `role=\"img\"`, and a\n  descriptive `aria-label`; inline the data in the markup.\n- Never rely on color alone: pair each series with dashes, markers, or\n  hatching.\n- Canvas does not resolve CSS variables; pass explicit hex values for marks.\n- Wrapper: give it an explicit height and `position: relative`.\n- Provide a custom HTML legend; do not depend on a library legend.\n- Dashboard layout: metric cards first, chart next, annotations last.\n- Geographic maps: draw simplified inline paths; never invent coordinates;\n  label the projection, simplify the source, and do not fetch topology at\n  runtime.\n- Round displayed values and state units, period, and source inline.\n",
  art: "### Art and illustration\n\n- Use SVG with the same technical constraints but a different aesthetic.\n- Fill the canvas and compose one focal subject.\n- Use bold but limited color: mix text and semantic categories from the\n  palette.\n- Layer overlapping opaque shapes for depth.\n- Build organic forms with `<path>` curves.\n- Create texture through repetition: lines, dots, hatching.\n- Use `<g transform=\"rotate(...)\">` for geometric patterns.\n- Keep the composition legible at 380px wide; drop fine detail that\n  disappears at that size.\n",
  elicitation: "### Interactive forms\n\n- Build forms as self-contained HTML with inline script. The artifact must\n  handle its own state and submit; never rely on a host shell to wire\n  controls or deliver answers.\n- Infer first: if the conversation already answers a question, skip the\n  form and continue the task.\n- Phrase prompts as questions from you, not field labels. Header:\n  \"[subject] details\".\n- Choice controls: plain pills (at most 4 words) for a few options, cards\n  with 16-20px SVG icons for richer choices, or 48x36 preview tiles for\n  output formats.\n- Color story: default to the blue ramp; use amber, red, or green only for\n  genuine semantics.\n- Include a textarea fallback beside file selection; show chosen files as\n  120x120 previews when possible.\n- On submit, summarize the answers inside the artifact itself, for example\n  \"Subject — Field: value · Field: value\". Optionally offer a\n  copy-to-clipboard action.\n- Do not promise that the assistant will receive the submitted answers or\n  continue the task automatically; the user still needs to send them in chat.\n",
} as const

export const IMAGINE_SECTION_ORDER = [
  "palette",
  "ui",
  "svg",
  "diagram",
  "data_viz",
  "art",
  "elicitation",
] as const

export const IMAGINE_MODULE_ROUTES = {
  "diagram": ["palette", "svg", "diagram"],
  "mockup": ["ui", "palette"],
  "interactive": ["ui", "palette"],
  "data_viz": ["ui", "palette", "data_viz"],
  "art": ["svg", "art"],
  "chart": ["ui", "palette", "data_viz"],
  "elicitation": ["elicitation"],
} as const

export const IMAGINE_MODULE_NAMES = [
  "diagram",
  "mockup",
  "interactive",
  "data_viz",
  "art",
  "chart",
  "elicitation",
] as const

export const IMAGINE_PLATFORM_WIDTHS = {
  "desktop": 680,
  "mobile": 380,
  "unknown": 680,
} as const

export type ImagineSection = (typeof IMAGINE_SECTION_ORDER)[number]
export type ImagineModule = (typeof IMAGINE_MODULE_NAMES)[number]
export type ImaginePlatform = keyof typeof IMAGINE_PLATFORM_WIDTHS
