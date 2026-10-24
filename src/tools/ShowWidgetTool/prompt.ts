export const SHOW_WIDGET_TOOL_NAME = 'show_widget'

export const DESCRIPTION = `Render a self-contained HTML or inline-SVG widget as one artifact.

Use this when the user asks for a visual: a chart, dashboard, diagram, UI
mockup, interactive explainer, illustration, or form. The tool validates the
payload and returns exactly one fenced \`\`\`artifact-html block with title and
description frontmatter. It does not write a file and does not call a backend.

The widget must be a fragment: no <!doctype>, <html>, <head>, or <body>. Inline
all CSS and JavaScript, embed images as data: URIs, and do not load external
scripts, stylesheets, fonts, images, or URLs. Do not use fetch, WebSocket,
EventSource, require, dynamic import(), static module imports, meta refresh,
or @import at all, even for a relative or same-origin target. Keep it flat,
sentence case, dark mode safe, and accessible.`

export function getPrompt(): string {
  return `Use \`${SHOW_WIDGET_TOOL_NAME}\` to deliver a visual artifact.

Input:
- \`title\`: short, non-empty title.
- \`description\`: optional one-sentence description.
- \`widget_code\`: self-contained HTML or inline SVG fragment.

The result is a single fenced artifact-html block; put explanation in the
reply, not in the widget. The fragment is rejected if it contains a full
document shell (<!doctype>, <html>, <head>, <body>), a triple-backtick fence
line, @import, a meta refresh, an external src/href/srcset/url(), or any
fetch(), WebSocket, EventSource, require(), dynamic import(), or static module
import, regardless of target. Inline scripts and styles are allowed.

Design: no gradients, glow, blur, or drop shadows; weights 400/500 only;
minimum 11px text; sentence case; dark-mode-safe colors; round displayed
numbers and state units.`
}
