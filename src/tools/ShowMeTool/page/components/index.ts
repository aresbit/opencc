// 组件注册表：围栏块语言名 → 组件。每个组件导出 { name, summary, syntax, example, render(text, ctx) }。
import callout from './callout.js';
import kv from './kv.js';
import timeline from './timeline.js';
import annot from './annot.js';
import tree from './tree.js';
import limits from './limits.js';
import sequence from './sequence.js';
import flow from './flow.js';
import type { Component } from '../types.js';

export { ComponentError } from './error.js';

const ALL: Component[] = [callout, kv, timeline, annot, tree, limits, sequence, flow];

export const COMPONENTS: Map<string, Component> = new Map(ALL.map((c) => [c.name, c]));
export const RAW_LANGS: Set<string> = new Set(['html', 'svg']);
