// Markdown → HTML（GFM）。附加两项装饰：表格包一层可横向滚动容器；单元格里的状态词渲染为徽章。

import { Marked } from 'marked';

const marked = new Marked({ gfm: true });

const STATUS: Record<string, { cls: string; icon: string }> = {
  ok: { cls: 'ok', icon: '✓' },
  no: { cls: 'no', icon: '✗' },
  warn: { cls: 'warn', icon: '!' },
};
const STATUS_ALIAS: Record<string, string> = { '✓': 'ok', '✔': 'ok', '✗': 'no', '✘': 'no', '⚠': 'warn' };

export function statusHtml(word: string, label = ''): string | null {
  const kind = STATUS[STATUS_ALIAS[word] ?? word];
  if (!kind) return null;
  const text = label.trim();
  return `<span class="am-status am-status--${kind.cls}"><span class="am-status-icon" aria-hidden="true">${kind.icon}</span>${text}</span>`;
}

const CELL_STATUS = /<td([^>]*)>\s*(ok|no|warn|✓|✔|✗|✘|⚠)(?:\s+([^<]*?))?\s*<\/td>/g;

function decorate(html: string): string {
  return html
    .replace(/<table>/g, '<div class="am-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(CELL_STATUS, (_m, attrs, word, label = '') => `<td${attrs}>${statusHtml(word, label)}</td>`);
}

export function md(text: unknown): string {
  return decorate(marked.parse(String(text ?? '')) as string);
}

export function mdInline(text: unknown): string {
  return marked.parseInline(String(text ?? '')) as string;
}
