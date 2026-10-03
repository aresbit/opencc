// SVG 布局在 Node 端完成，拿不到真实字体度量，只能按字符类别估算宽度。
// 估算偏宽比偏窄安全：宁可节点留白，也不要文字溢出边框。

// Ranges spelled as BMP escapes so the class is byte-identical to upstream's literal glyphs:
// U+2E80-9FFF (CJK radicals..unified), U+AC00-D7AF (Hangul), U+F900-FAFF (CJK compat),
// U+FE30-FE4F (vertical forms), U+FF00-FFEF (half/full forms), U+3000-303F (CJK punctuation).
const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/;
const NARROW = new Set([...'iljtfrI.,:;|!\'`()[]{}']);
const WIDE = new Set([...'mwMWOQGD@%&']);

export function isCJK(ch: string): boolean {
  return CJK_RE.test(ch);
}

function charWidth(ch: string, mono: boolean): number {
  if (isCJK(ch)) return 1;
  if (mono) return 0.6;
  if (ch === ' ') return 0.3;
  if (NARROW.has(ch)) return 0.32;
  if (WIDE.has(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.56;
}

export function measure(str: unknown, size = 13, { mono = false }: { mono?: boolean } = {}): number {
  let units = 0;
  for (const ch of String(str ?? '')) units += charWidth(ch, mono);
  return Math.round(units * size * 100) / 100;
}

// 切成不可再分的排版单元：一个汉字是一个单元，一段连续的非空白拉丁字符是一个单元。
function tokenize(str: string): string[] {
  return String(str).match(/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]|[^\s\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]+|\s+/g) ?? [];
}

export function wrap(str: unknown, maxWidth: number, size = 13, opts: { mono?: boolean } = {}): string[] {
  const lines: string[] = [];
  let line = '';
  for (const tok of tokenize(String(str))) {
    if (/^\s+$/.test(tok)) {
      if (line) line += ' ';
      continue;
    }
    const candidate = line + tok;
    if (line.trim() && measure(candidate, size, opts) > maxWidth) {
      lines.push(line.trimEnd());
      line = tok;
    } else {
      line = candidate;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
