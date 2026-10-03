// 组件语法错误。line 是围栏块内容内的相对行号（1 起算），render.js 负责换算成源文件行号。
export class ComponentError extends Error {
  line: number;
  constructor(message: string, line = 0) {
    super(message);
    this.name = 'ComponentError';
    this.line = line;
  }
}

export interface ContentLine {
  raw: string;
  text: string;
  line: number;
}

// 把围栏块文本切成非空行，保留相对行号；支持 # 开头的整行注释。
export function contentLines(text: unknown): ContentLine[] {
  return String(text)
    .split('\n')
    .map((raw, i) => ({ raw, text: raw.trim(), line: i + 1 }))
    .filter((l) => l.text && !l.text.startsWith('//'));
}

// 按 | 拆字段并去掉首尾空白。
export function fields(text: string): string[] {
  return text.split('|').map((s) => s.trim());
}
