import { mdInline } from '../markdown.js';
import { esc } from '../svg/text.js';
import { ComponentError, contentLines } from './error.js';
import { parseAttrs } from '../parse.js';
import type { Component } from '../types.js';

const kv: Component = {
  name: 'kv',
  summary: '键值格 / 标题栏（元信息）',
  syntax: `\`\`\`kv [cols=2]
键: 值
* 宽格键: 值        ← * 开头：占满整行，字号更大
\`\`\`
- 按第一个冒号（: 或 ：）切分，值里可以再出现冒号。`,
  example: '```kv cols=2\n* Title: Simplified Technical English\nSpecification: ASD-STE100\nOwner: ASD\n```',
  render(text, { args }) {
    const cols = Math.max(1, Math.min(Number(parseAttrs(args).cols) || 2, 6));
    const cells = contentLines(text).map(({ text: t, line }) => {
      const wide = t.startsWith('*');
      const body = wide ? t.slice(1).trim() : t;
      const m = body.match(/^([^:：]+)[:：]\s*(.*)$/);
      if (!m) throw new ComponentError(`kv 行缺少冒号："${t}"，应为 键: 值`, line);
      return `<div class="am-kv-cell${wide ? ' am-kv-cell--wide' : ''}"><dt>${esc(m[1].trim())}</dt><dd>${mdInline(m[2])}</dd></div>`;
    });
    if (!cells.length) throw new ComponentError('kv 至少需要一行 键: 值', 1);
    return `<dl class="am-kv" style="--kv-cols: ${cols}">${cells.join('')}</dl>`;
  },
};

export default kv;
