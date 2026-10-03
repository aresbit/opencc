export const SHOW_ME_TOOL_NAME = 'showme'

export const DESCRIPTION = `Explain a concept visually — pick the smallest format that makes the key point clear, render it, and return the result.

Actions (selected with \`action\`):

**action: "page"** — write a content *draft* (YAML frontmatter + \`## \` panels) and render a self-contained HTML page. The renderer does layout, color and coordinates, so do NOT hand-write HTML/CSS/SVG. Use this when the answer has 3+ interconnected concepts, a flow/protocol/state with branches or several actors, a 3+-dimension comparison or tradeoff, or a hierarchy/timeline. Writes the page to a file and returns its path.

**action: "diagram"** (default) — render a Mermaid diagram (flowchart, sequence, class, state, ER, gantt, pie, mindmap, timeline, etc.) from a \`spec\` string. Returns the Mermaid source and an SVG render (if mermaid-cli is available) or the raw source for the caller to render.

**action: "tree"** — render a file tree, component tree, or call tree from a \`spec\` string (indented text, one node per line). Returns a formatted tree.

**action: "diff"** — render a before/after diff view from \`before\` and \`after\` strings. Returns a unified diff.

**action: "table"** — render a comparison table from \`headers\` and \`rows\`. Returns a markdown table.

**action: "pseudocode"** — format pseudocode from a \`spec\` string. Returns syntax-highlighted pseudocode.

**action: "html"** — render a custom HTML artifact for concepts too dense for Mermaid (layouts, state comparisons, interactive visuals). Takes \`spec\` as the HTML content, writes it to a workspace file, and returns the path.

Format selection guide (use the smallest format that answers the question):
- \`page\` → the whole explanation: several concepts, a branching flow, a multi-dimension tradeoff, a timeline or hierarchy
- Pseudocode → logic, algorithms, step-by-step
- Tree → file structure, component hierarchy, call chain
- Mermaid diagram → interactions, data flow, state machines, sequences, architecture
- Diff → what changed between two versions
- Table → feature comparison, option matrix, API surface
- HTML → layouts, state comparisons, anything too dense for Mermaid`

export function getPrompt() {
  return [
    'Use `showme` to explain a concept visually rather than with a wall of text.',
    '',
    'Lead with action:"page" when the answer needs a whole explanation:',
    '- 3+ interconnected concepts;',
    '- a flow, protocol or state machine with branches or several actors;',
    '- a comparison or tradeoff across 3+ dimensions;',
    '- a hierarchy or timeline.',
    'Write a content *draft* and render a page. Do NOT hand-write HTML, CSS or SVG — the renderer does layout, color and coordinates.',
    '',
    'Draft format:',
    '- YAML frontmatter between `---` lines: `template: sheet|doc`, `theme: blueprint|shadcn`, `title`, `subtitle`, `cols`, `source`.',
    '- Every `## ` heading starts a panel. Panel modifiers go at the end of the heading: `{span=2}`, `{rows=2}`, `{bare}`.',
    '- Panel letter IDs (A, B, C...) are assigned automatically — do not write them.',
    '- Put markdown text, a component fence, or a raw fence in the panel body.',
    '',
    'Pick one component per panel by information shape (use a fenced block):',
    '- `flow [LR]` — steps and branches: `A -> B: label`, `A --> C`, fan-out `A -> B & C`, arrow `-->`, shapes `(round)` `{dia}` `[(db)]` `[rect]`, `group G: A, B`.',
    '- `sequence [num]` — request/response over time: `A -> B: req`, `B --> A: resp`, `note A,B: text`, `== phase ==`.',
    '- `tree [list]` — containment: indented lines, `label | sub`, prefix `*` to highlight.',
    '- `timeline [h|v]` — chronology: `when | title | detail`, prefix `*` for the present.',
    '- `limits` — budget against a cap: `label | cur / max | unit`.',
    '- `annot` — annotated prose: `# title | meta`, mark `[seg]{note}`, flag `[bad]{!err}`, caption `> text`.',
    '- `kv [cols=N]` — key/value facts: `key: value`, prefix `*` for a wide row.',
    '- `callout <info|ok|warn|err> title` — one emphasized point.',
    '- Markdown table — matrix cells `ok` / `no` / `warn` render as ✓ / ✗ / !.',
    '- ```html / ```svg — escape hatches when no component fits.',
    '',
    'Example draft:',
    '```',
    '---',
    'title: Request path',
    'theme: blueprint',
    '---',
    '## Entry {span=2}',
    '```flow LR',
    '(client) -> edge: HTTPS',
    'edge -> auth & *api',
    'api -> [(store)]',
    '```',
    '## Notes',
    'One request touches three services.',
    '```',
    '',
    'Self-repair: if the tool returns `L<n> [component] ...` with a correct example, fix that line and re-render. At most 2 rounds, then keep the page and explain.',
    '',
    'STE writing rules apply to the draft text:',
    '- One idea per sentence. Active voice; imperative for steps.',
    '- Sentence limits: en 20 words (steps) / 25 (descriptive); zh 35 / 45 characters.',
    '- At most 6 sentences per paragraph. Prefer short words (use not utilize, start not commence, before not prior to).',
    '- In Chinese, drop empty verbs (进行优化 → 优化) and avoid cliches (赋能 / 闭环 / 至关重要).',
    '- `style: strict` refuses to render on any warning; `style: off` disables the check.',
    '',
    'For a single quick visual, use the smaller actions instead:',
    '1. **Pick the smallest format** that makes the key point clear. A 5-line tree beats a 30-line Mermaid when all you need is file structure.',
    '2. **Keep only what answers the question.** Strip nodes/rows/steps that do not contribute to the current question.',
    '3. **Prose is a caption, not the explanation.** One or two sentences adjacent to the visual. The visual IS the explanation.',
    '4. **Diff when the point is change.** Show whole blocks only when most content is new or context matters.',
    '5. **page is for whole explanations.** Reach for html only when a page is still not the right shape.',
    '',
    'Do not over-annotate. Do not add a legend unless the symbols are ambiguous. Do not wrap a simple concept in a complex format.',
  ].join('\n')
}
