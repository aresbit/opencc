// doc：线性讲解。单栏阅读，面板 ≥ 3 个时左侧给出目录。
import { panelHtml, headHtml } from './panel.js';
import { esc } from '../svg/text.js';
import type { Meta, RenderedPanel } from '../types.js';

export function doc({ meta, introHtml, panels }: { meta: Meta; introHtml: string; panels: RenderedPanel[] }): string {
  const withToc = panels.length >= 3;
  const toc = withToc
    ? `<nav class="am-toc" aria-label="目录">${panels.map((p) => `<a href="#panel-${esc(p.id)}">${esc(p.id)} · ${esc(p.title)}</a>`).join('')}</nav>`
    : '';
  return `<main class="am-doc">
${headHtml(meta, introHtml)}
<div class="am-doc-layout${withToc ? '' : ' am-doc-layout--notoc'}">
${toc}<div class="am-doc-body">
${panels.map((p) => panelHtml(p, { grid: false })).join('\n')}
</div>
</div>
</main>`;
}
