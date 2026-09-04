export const SHOW_ME_TOOL_NAME = 'showme'

export const DESCRIPTION = `Explain a concept visually — pick the smallest format that makes the key point clear, render it, and return the result.

Actions (selected with \`action\`):

**action: "diagram"** (default) — render a Mermaid diagram (flowchart, sequence, class, state, ER, gantt, pie, mindmap, timeline, etc.) from a \`spec\` string. Returns the Mermaid source and an SVG render (if mermaid-cli is available) or the raw source for the caller to render.

**action: "tree"** — render a file tree, component tree, or call tree from a \`spec\` string (indented text, one node per line). Returns a formatted tree.

**action: "diff"** — render a before/after diff view from \`before\` and \`after\` strings. Returns a unified diff.

**action: "table"** — render a comparison table from \`headers\` and \`rows\`. Returns a markdown table.

**action: "pseudocode"** — format pseudocode from a \`spec\` string. Returns syntax-highlighted pseudocode.

**action: "html"** — render a custom HTML artifact for concepts too dense for Mermaid (layouts, state comparisons, interactive visuals). Takes \`spec\` as the HTML content, writes it to a workspace file, and returns the path.

Format selection guide (use the smallest format that answers the question):
- Pseudocode → logic, algorithms, step-by-step
- Tree → file structure, component hierarchy, call chain
- Mermaid diagram → interactions, data flow, state machines, sequences, architecture
- Diff → what changed between two versions
- Table → feature comparison, option matrix, API surface
- HTML → layouts, state comparisons, anything too dense for Mermaid`

export function getPrompt() {
  return `Use \`showme\` to explain a concept visually rather than with a wall of text.

Rules:
1. **Pick the smallest format** that makes the key point clear. A 5-line tree beats a 30-line Mermaid when all you need is file structure.
2. **Keep only what answers the question.** Strip nodes/rows/steps that don't contribute to the user's current question.
3. **Prose is a caption, not the explanation.** One or two sentences adjacent to the visual. The visual IS the explanation.
4. **Diff when the point is change.** Show whole blocks only when most content is new or context matters.
5. **HTML is last resort.** Only for layouts, state machines with visual state, or concepts too dense for Mermaid.

Do not over-annotate diagrams. Do not add a legend unless the symbols are ambiguous. Do not wrap simple concepts in complex formats.`
}
