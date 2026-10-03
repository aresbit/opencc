// 句子标注（配图 B）：等宽字体排句子，被标注片段下方画括号线，注释按横向位置自动错行避免重叠。
import { esc, measure } from '../svg/text.js';
import { ComponentError, contentLines, fields } from './error.js';
import type { Component } from '../types.js';

const SEG = /\[([^\]]+)\]\{(!?)([^}]*)\}/g;
const TEXT_SIZE = 14;
const NOTE_SIZE = 11;
const NOTE_GAP = 10;

interface AnnotGroup {
  title: string;
  meta: string;
  lines: string[];
  captions: string[];
}

const annot: Component = {
  name: 'annot',
  summary: '句子逐段标注（下划括号 + 注释）',
  syntax: `\`\`\`annot
# 小标题 | 右侧说明（可选）
句子文本，[被标注片段]{注释}，[错误片段]{!红色注释}。
> 底部说明（可选）
\`\`\`
- 一个 # 开启一组；同组可有多句。注释重叠时自动错行。`,
  example: '```annot\n# 1 程序性句子 | 13 words, limit 20\nMake sure that [the hydraulic reservoir]{Technical name} is [full]{!Not "replenished"}.\n> 一句只写一条指令\n```',
  render(text) {
    const groups: AnnotGroup[] = [];
    let group: AnnotGroup | null = null;
    const ensure = (): AnnotGroup => group ?? (group = pushGroup(groups, {}));
    for (const { text: t, line } of contentLines(text)) {
      if (t.startsWith('#')) {
        const [title, meta = ''] = fields(t.replace(/^#+\s*/, ''));
        group = pushGroup(groups, { title, meta });
      } else if (t.startsWith('>')) {
        ensure().captions.push(t.replace(/^>\s*/, ''));
      } else {
        ensure().lines.push(sentenceHtml(t, line));
      }
    }
    if (!groups.length) throw new ComponentError('annot 至少需要一个句子', 1);
    return groups.map(groupHtml).join('');
  },
};

function pushGroup(groups: AnnotGroup[], { title = '', meta = '' }): AnnotGroup {
  const g: AnnotGroup = { title, meta, lines: [], captions: [] };
  groups.push(g);
  return g;
}

function groupHtml(g: AnnotGroup): string {
  const head = g.title || g.meta
    ? `<div class="am-annot-head"><span>${esc(g.title)}</span>${g.meta ? `<span class="am-annot-meta">${esc(g.meta)}</span>` : ''}</div>`
    : '';
  const lines = g.lines.map((l) => `<div class="am-annot-scroll">${l}</div>`).join('');
  const caps = g.captions.map((c) => `<div class="am-annot-caption">${esc(c)}</div>`).join('');
  return `<div class="am-annot">${head}${lines}${caps}</div>`;
}

function sentenceHtml(sentence: string, line: number): string {
  const stripped = sentence.replace(SEG, '');
  if (/\[[^\]]*\]\{|\]\{[^}]*$/.test(stripped)) {
    throw new ComponentError(`annot 标注未闭合，应为 [片段]{注释}："${sentence}"`, line);
  }
  const rows: number[][][] = [];
  let out = '';
  let plain = '';
  let last = 0;
  for (const m of sentence.matchAll(SEG)) {
    const before = sentence.slice(last, m.index);
    out += esc(before);
    plain += before;
    const [, seg, bang, note] = m;
    const x = measure(plain, TEXT_SIZE, { mono: true });
    const noteHtml = note.trim()
      ? `<span class="am-seg-n" style="--row: ${placeNote(rows, x, x + measure(note, NOTE_SIZE) + NOTE_GAP)}">${esc(note.trim())}</span>`
      : '';
    out += `<span class="am-seg${bang ? ' am-seg--err' : ''}"><span class="am-seg-t">${esc(seg)}</span>${noteHtml}</span>`;
    plain += seg;
    last = m.index + m[0].length;
  }
  out += esc(sentence.slice(last));
  const wrapCls = rows.length ? '' : ' am-annot-line--wrap';
  return `<div class="am-annot-line${wrapCls}" style="--rows: ${rows.length}">${out}</div>`;
}

// 贪心放置：取第一个与已有注释不重叠的行。
function placeNote(rows: number[][][], start: number, end: number): number {
  const idx = rows.findIndex((ranges) => ranges.every(([s, e]) => end <= s || start >= e));
  if (idx !== -1) {
    rows[idx].push([start, end]);
    return idx;
  }
  rows.push([[start, end]]);
  return rows.length - 1;
}

export default annot;
