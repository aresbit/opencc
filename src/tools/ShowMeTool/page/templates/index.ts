import { sheet } from './sheet.js';
import { doc } from './doc.js';
import type { Meta, RenderedPanel } from '../types.js';

export type TemplateFn = (arg: { meta: Meta; introHtml: string; panels: RenderedPanel[] }) => string;

export const TEMPLATES: Record<string, TemplateFn> = { sheet, doc };
