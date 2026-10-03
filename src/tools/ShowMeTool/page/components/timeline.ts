import { mdInline } from '../markdown.js';
import { esc } from '../svg/text.js';
import { ComponentError, contentLines, fields } from './error.js';
import type { Component } from '../types.js';

const timeline: Component = {
  name: 'timeline',
  summary: '时间线 / 阶段演进',
  syntax: `\`\`\`timeline [h|v]
时间 | 标题 | 说明（可选）
*时间 | 标题          ← * 开头：高亮该节点
\`\`\`
- 默认 ≤6 项横向、>6 项纵向；参数 h / v 强制方向。`,
  example: '```timeline\n1979 | AECMA 启动研究\n1986 | 首版指南发布\n*Now | 免费下载 | 由 ASD STEMG 维护\n```',
  render(text, { args }) {
    const items = contentLines(text).map(({ text: t, line }) => {
      const parts = fields(t);
      if (parts.length < 2 || !parts[1]) throw new ComponentError(`timeline 行格式应为 时间 | 标题 | 说明："${t}"`, line);
      const hi = parts[0].startsWith('*');
      return { when: hi ? parts[0].slice(1).trim() : parts[0], title: parts[1], detail: parts[2] ?? '', hi };
    });
    if (!items.length) throw new ComponentError('timeline 至少需要一项', 1);
    const vertical = /\bv(ertical)?\b/.test(args) || (!/\bh(orizontal)?\b/.test(args) && items.length > 6);
    const lis = items.map((it) => `<li class="am-tl-item${it.hi ? ' am-tl-item--hi' : ''}"><span class="am-tl-when">${esc(it.when)}</span><span class="am-tl-dot"></span><span class="am-tl-title">${mdInline(it.title)}</span>${it.detail ? `<span class="am-tl-text">${mdInline(it.detail)}</span>` : ''}</li>`);
    return vertical
      ? `<ol class="am-timeline am-timeline--v">${lis.join('')}</ol>`
      : `<ol class="am-timeline am-timeline--h" style="--n: ${items.length}">${lis.join('')}</ol>`;
  },
};

export default timeline;
