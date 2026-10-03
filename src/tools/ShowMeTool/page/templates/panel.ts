import { esc } from '../svg/text.js';
import type { Meta, RenderedPanel } from '../types.js';

export function panelHtml(panel: RenderedPanel, { cols = 3, grid = true }: { cols?: number; grid?: boolean } = {}): string {
  const { attrs } = panel;
  const span = Math.min(Number(attrs.span) || 1, cols);
  const rows = Number(attrs.rows) || 1;
  const layout = [
    grid && span > 1 ? `grid-column: span ${span}` : '',
    grid && rows > 1 ? `grid-row: span ${rows}` : '',
  ].filter(Boolean).join('; ');
  const style = layout ? ` style="${layout}"` : '';
  const cls = `${span > 1 ? ' am-span-wide' : ''}${attrs.bare ? ' am-panel--bare' : ''}`;
  const meta = attrs.meta ? `<span class="am-panel-meta">${esc(attrs.meta)}</span>` : '';
  const head = attrs.bare
    ? ''
    : `<header class="am-panel-head"><span class="am-panel-id">${esc(panel.id)}</span><h2>${esc(panel.title)}</h2>${meta}</header>\n`;
  return `<section class="am-panel${cls}" id="panel-${esc(panel.id)}"${style}>
${head}<div class="am-panel-body">${panel.html}</div>
</section>`;
}

const RESERVED = new Set(['template', 'theme', 'style', 'mode', 'cols', 'title', 'subtitle', 'lang']);

export function headHtml(meta: Meta, introHtml: string): string {
  const extras = Object.entries(meta).filter(([k, v]) => !RESERVED.has(k) && v !== '');
  const metaRow = extras.length
    ? `<div class="am-head-meta">${extras.map(([k, v]) => `<span><b>${esc(k)}</b>${esc(v)}</span>`).join('')}</div>`
    : '';
  const sub = meta.subtitle ? `<p class="am-sub">${esc(meta.subtitle)}</p>` : '';
  const intro = introHtml ? `<div class="am-intro am-md">${introHtml}</div>` : '';
  return `<header class="am-head"><h1>${esc(meta.title || 'Untitled')}</h1>${sub}${metaRow}${intro}</header>`;
}
