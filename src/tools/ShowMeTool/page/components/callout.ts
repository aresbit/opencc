import { md } from '../markdown.js';
import { esc } from '../svg/text.js';
import { ComponentError } from './error.js';
import type { Component } from '../types.js';

const KINDS = new Set(['info', 'ok', 'warn', 'err']);

const callout: Component = {
  name: 'callout',
  summary: '结论 / 提示 / 警告条',
  syntax: `\`\`\`callout <info|ok|warn|err> [标题]
正文（Markdown）
\`\`\`
- 首个参数不是类型时，整个参数串作为标题，类型为 info。`,
  example: '```callout warn 注意\n先关闭阀门，再拆卸泵。\n```',
  render(text, { args }) {
    const [first = '', ...rest] = args.split(/\s+/).filter(Boolean);
    const kind = KINDS.has(first) ? first : 'info';
    const title = (KINDS.has(first) ? rest.join(' ') : args).trim();
    if (!title && !text.trim()) throw new ComponentError('callout 需要标题或正文', 1);
    const head = title ? `<div class="am-callout-title">${esc(title)}</div>` : '';
    const body = text.trim() ? `<div class="am-callout-body am-md">${md(text)}</div>` : '';
    return `<div class="am-callout am-callout--${kind}" role="note">${head}${body}</div>`;
  },
};

export default callout;
