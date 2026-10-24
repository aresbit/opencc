export const READ_ME_TOOL_NAME = 'read_me'

export const DESCRIPTION = `Read the Imagine visual-creation guidance for one or more modules.

Use this before producing a visual artifact when you need the exact module
rules: streaming-safe order, design system, color palette, SVG sizing, chart
constraints, or form conventions. The returned text is the checked-in asset
generated from the backend Imagine prompt source; it is read-only and never
touches the filesystem or network.

Modules: diagram, mockup, interactive, data_viz, art, chart, elicitation.
Platform: mobile (380px), desktop (680px), or unknown (desktop-first, 680px).
\`modules\` defaults to \`diagram\` and \`platform\` defaults to \`desktop\` when
omitted. Pick exactly one module for a single visual; pass an array to combine
shared sections without duplication.`

export function getPrompt(): string {
  return `Use \`${READ_ME_TOOL_NAME}\` to load the Imagine module guidance before rendering a visual artifact.

- \`modules\`: one module name or an array. Values: diagram, mockup, interactive, data_viz, art, chart, elicitation. Defaults to \`diagram\`.
- \`platform\`: mobile (380px), desktop (680px), or unknown (680px fallback). Defaults to \`desktop\`.

The tool returns the module prompt text: the base design system plus the
sections routed to the requested module, with the target viewport width.
Prefer one module per artifact. Request an array only when the visual genuinely
spans modes; shared sections are emitted once in canonical order.`
}
