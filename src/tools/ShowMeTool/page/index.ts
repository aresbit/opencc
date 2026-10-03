// Public entry point for the ported answer-me-with-html rendering pipeline (v0.2.2).
// Frozen API: the ShowMeTool wiring depends on exactly these exports.
//
// Ported from https://github.com/QingYunA/answer-me-with-html (MIT).
// Copyright (c) 2026 Answer me with HTML contributors — see ./LICENSE.

export type { RenderOverrides, Warning, Meta, RenderStats, RenderResult } from './types.js';

export { ParseError } from './parse.js';
export { RenderError, LintError, renderPage, detectLang } from './render.js';
export { ComponentError } from './components/error.js';
export { formatWarning } from './lint/ste.js';
