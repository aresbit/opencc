// sheet：图纸板。字母编号面板排成网格；blueprint 主题下外框带坐标刻度（纯装饰，无交互）。
import { panelHtml, headHtml } from './panel.js';
import type { Meta, RenderedPanel } from '../types.js';

const ruler = (side: string, labels: (string | number)[]) =>
  `<div class="am-ruler am-ruler--${side}" aria-hidden="true">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;

// 按阅读顺序模拟网格：某面板之后的剩余列放不下下一个面板时，把它拉宽填满本行，避免留下空洞。
// 有面板使用 rows 跨行时，行的占用关系复杂，直接保留作者的布局。
export function fillRows(panels: RenderedPanel[], cols: number): number[] {
  const spans = panels.map((p) => Math.max(1, Math.min(Number(p.attrs.span) || 1, cols)));
  if (panels.some((p) => Number(p.attrs.rows) > 1)) return spans;
  let used = 0;
  return spans.map((span, i) => {
    if (used + span > cols) used = 0;
    used += span;
    const next = spans[i + 1];
    const fill = next === undefined || used + next > cols ? cols - used : 0;
    used = fill || used === cols ? 0 : used;
    return span + fill;
  });
}

export function sheet({ meta, introHtml, panels }: { meta: Meta; introHtml: string; panels: RenderedPanel[] }): string {
  const cols = Math.max(1, Math.min(Number(meta.cols) || 3, 12));
  const spans = fillRows(panels, cols);
  const placed = panels.map((p, i) => ({ ...p, attrs: { ...p.attrs, span: spans[i] } }));
  const nums = Array.from({ length: 8 }, (_, i) => i + 1);
  const letters = ['A', 'B', 'C', 'D'];
  return `<main class="am-sheet">
${headHtml(meta, introHtml)}
<div class="am-frame">
${ruler('top', nums)}${ruler('bottom', nums)}${ruler('left', letters)}${ruler('right', letters)}
<div class="am-grid" style="--cols: ${cols}">
${placed.map((p) => panelHtml(p, { cols })).join('\n')}
</div>
</div>
</main>`;
}
