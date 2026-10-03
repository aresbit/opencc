// Shared internal + public types for the page renderer.
// The public subset (RenderOverrides / Warning / Meta / RenderStats / RenderResult)
// is re-exported unchanged from index.ts.

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface MdBlock {
  type: 'md';
  text: string;
  line: number;
}

export interface FenceBlock {
  type: 'fence';
  lang: string;
  args: string;
  text: string;
  line: number;
}

export type Block = MdBlock | FenceBlock;

export interface Panel {
  id: string | null;
  title: string;
  attrs: Attrs;
  line: number;
  blocks: Block[];
}

export interface Doc {
  meta: Meta;
  intro: Block[];
  panels: Panel[];
}

// A panel after its blocks have been rendered to HTML; the shape templates consume.
export interface RenderedPanel extends Panel {
  html: string;
}

export interface ComponentCtx {
  args: string;
  uid: () => string;
}

export interface Component {
  name: string;
  summary: string;
  syntax: string;
  example: string;
  render(text: string, ctx: ComponentCtx): string;
}

// ---- Frozen public API types ----

export interface RenderOverrides {
  template?: 'sheet' | 'doc';
  theme?: 'blueprint' | 'shadcn';
  style?: 'off' | '80' | 'strict';
  mode?: 'auto' | 'light' | 'dark';
  cols?: number;
}

export interface Warning {
  line: number;
  rule: string;
  message: string;
  suggestion?: string;
}

export interface Meta {
  template: string;
  theme: string;
  style: string;
  mode: string;
  cols: number | string;
  title: string;
  subtitle?: string;
  lang?: string;
  [k: string]: unknown;
}

export interface RenderStats {
  panels: number;
  components: Record<string, number>;
}

export interface RenderResult {
  html: string;
  warnings: Warning[];
  stats: RenderStats;
  meta: Meta;
}
