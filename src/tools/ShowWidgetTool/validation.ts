/**
 * Pure validation and rendering for show_widget.
 *
 * The tool never writes files and never calls a backend: it turns a
 * self-contained HTML/SVG fragment into the single fenced artifact block the
 * host renders.  Everything here is synchronous and side-effect free so the
 * checks can be exercised directly in tests.
 */

export const MAX_WIDGET_CODE_CHARS = 1_150_000
export const MAX_TITLE_CHARS = 500
export const MAX_DESCRIPTION_CHARS = 2_000

const DOCUMENT_SHELL_RE = /<\s*(?:!doctype|html|head|body)\b/i
const FENCE_LINE_RE = /^[ \t]*```/m
const ATTRIBUTE_RE =
  /(?:^|[\s"'`/])([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi
const CSS_IMPORT_RE = /@import\b/i
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const META_REFRESH_RE =
  /\bhttp-equiv\s*=\s*(?:"\s*refresh\s*"|'\s*refresh\s*'|refresh\b)/i

// ASCII-producing named character references.  Inline event handlers are
// HTML attribute values, so a parser resolves these before JavaScript runs:
// `fetch&lpar;` reaches the engine as `fetch(`.  The table is deliberately
// small but covers every ASCII character that can rebuild an identifier or
// call syntax.  Names are stored lower-cased and matched case-insensitively.
const NAMED_ENTITIES: Record<string, string> = {
  tab: '\t',
  newline: '\n',
  excl: '!',
  quot: '"',
  num: '#',
  dollar: '$',
  percnt: '%',
  amp: '&',
  apos: "'",
  lpar: '(',
  rpar: ')',
  ast: '*',
  midast: '*',
  plus: '+',
  comma: ',',
  period: '.',
  sol: '/',
  colon: ':',
  semi: ';',
  lt: '<',
  equals: '=',
  gt: '>',
  quest: '?',
  commat: '@',
  lsqb: '[',
  lbrack: '[',
  bsol: '\\',
  rsqb: ']',
  rbrack: ']',
  hat: '^',
  lowbar: '_',
  grave: '`',
  diacriticalgrave: '`',
  lcub: '{',
  lbrace: '{',
  verbar: '|',
  vert: '|',
  verticalline: '|',
  rcub: '}',
  rbrace: '}',
}

// These constructs are rejected entirely, regardless of their target.  The
// artifact is a fragment rendered under a strict CSP, so a same-origin or
// relative fetch/import is still a network or module load we do not allow.
// Optional calls and member/bracket retrieval are included because they reach
// the same APIs without spelling the plain call form.
const OWNERS = String.raw`\b(?:window|globalThis|self|this)`
const CONSTRUCT_NAMES = 'fetch|WebSocket|EventSource|require|import'
const FORBIDDEN_CONSTRUCTS: Array<[string, RegExp]> = [
  ['fetch()', /\bfetch\s*(?:\?\.)?\s*\(/i],
  ['WebSocket()', /\bWebSocket\s*(?:\?\.)?\s*\(/i],
  ['EventSource()', /\bEventSource\s*(?:\?\.)?\s*\(/i],
  ['require()', /\brequire\s*(?:\?\.)?\s*\(/i],
  ['a dynamic import()', /\bimport\s*(?:\?\.)?\s*\(/i],
  [
    'a static module import',
    /\bimport\s+(?:type\s+)?(?:[^;'"`]*?\bfrom\s*)?['"]/i,
  ],
  [
    'bracket access to a network/module API',
    new RegExp(
      `${OWNERS}\\s*(?:\\?\\.)?\\s*\\[\\s*['"\`]\\s*(?:${CONSTRUCT_NAMES})\\s*['"\`]\\s*\\]`,
      'i',
    ),
  ],
  [
    'member access to a network/module API',
    new RegExp(`${OWNERS}\\s*(?:\\?\\.|\\.)\\s*(?:${CONSTRUCT_NAMES})\\b`, 'i'),
  ],
]

// External navigation is a network/loading side effect too, but only when the
// receiver is a navigation owner.  Reads (`window.location.pathname`,
// `state.location.href`) and local objects with `location`/`open` properties
// must stay legal.  Owners can be chained (`window.top`, `self.top`,
// `window.opener`, `window.top.frames[0]`) and accessed with dots, optional
// chaining, or string brackets.
const OWNER_NAME = String.raw`(?:window|self|globalThis|top|parent|this|opener)`
const DOCUMENT_OWNER = String.raw`document(?:\s*\.\s*defaultView|\s*\[\s*['"]\s*defaultView\s*['"]\s*\])?`
const OWNER_BASE = `(?:${OWNER_NAME}|${DOCUMENT_OWNER})`
const OWNER_STEP = String.raw`(?:\s*(?:\?\.|\.)\s*${OWNER_BASE}|\s*(?:\?\.)?\s*\[\s*['"\`]\s*(?:${OWNER_NAME}|defaultView)\s*['"\`]\s*\])`
const OWNER_CHAIN = `${OWNER_BASE}(?:${OWNER_STEP})*`
const FRAMES_ACCESS = String.raw`(?:\s*(?:\?\.|\.)\s*frames|\s*(?:\?\.)?\s*\[\s*['"\`]\s*frames\s*['"\`]\s*\]|\s*\bframes)\s*\[[^\]]*\]`
const FRAMES_OWNER = `(?:${OWNER_CHAIN})?${FRAMES_ACCESS}`
const NAV_OWNER = `(?:${OWNER_CHAIN}|${FRAMES_OWNER})`
const NAV_PREFIX = String.raw`(?:^|[^.\w$])`
const NAV_LOCATION = String.raw`(?:\?\.\s*location|\.\s*location|\?\.\s*\[\s*['"\`]\s*location\s*['"\`]\s*\]|\[\s*['"\`]\s*location\s*['"\`]\s*\])`
const NAV_LOCATION_SINK = String.raw`(?:\s*=(?!=)|\s*(?:\?\.\s*href|\.\s*href|\[\s*['"\`]\s*href\s*['"\`]\s*\])\s*=(?!=)|\s*(?:\?\.\s*(?:assign|replace)|\.\s*(?:assign|replace)|\[\s*['"\`]\s*(?:assign|replace)\s*['"\`]\s*\])\s*(?:\?\.)?\s*\()`
const NAV_OWNER_LOCATION_RE = new RegExp(
  `${NAV_PREFIX}${NAV_OWNER}\\s*${NAV_LOCATION}${NAV_LOCATION_SINK}`,
  'i',
)
// Any retrieval of `open` from a navigation owner is rejected, including
// aliasing (`const o = window.open`) and optional/bracket forms.
const NAV_OWNER_OPEN_ACCESS_RE = new RegExp(
  `${NAV_PREFIX}(?:${NAV_OWNER}\\s*(?:\\?\\.|\\.)\\s*open\\b|${NAV_OWNER}\\s*(?:\\?\\.)?\\s*\\[\\s*['"\`]\\s*open\\s*['"\`]\\s*\\])`,
  'i',
)
const NAV_BARE_OPEN_CALL_RE = /(?:^|[^.\w$])open\s*(?:\?\.)?\s*\(/i

/**
 * Detect a sink on a bare `location` (the implicit global).  `state.location`
 * and declarations such as `const location = {...}` are not sinks.
 */
function hasBareNavigationSink(code: string): boolean {
  for (const match of code.matchAll(/(?:^|[^.\w$\]])\s*(location)\b/gi)) {
    const locationStart =
      match.index + match[0].toLowerCase().lastIndexOf('location')
    const before = code.slice(0, locationStart)
    if (/\b(?:const|let|var)\s+$/.test(before)) continue

    const rest = code.slice(locationStart + 'location'.length)
    if (/^\s*=(?!=)/.test(rest)) return true
    if (
      /^\s*(?:\?\.\s*href|\.\s*href|\[\s*['"`]\s*href\s*['"`]\s*\])\s*=(?!=)/.test(
        rest,
      )
    ) {
      return true
    }
    if (
      /^\s*(?:\?\.\s*(?:assign|replace)|\.\s*(?:assign|replace)|\[\s*['"`]\s*(?:assign|replace)\s*['"`]\s*\])\s*(?:\?\.)?\s*\(/.test(
        rest,
      )
    ) {
      return true
    }
  }
  return false
}

/** Error raised when a widget is not safe to render as a self-contained artifact. */
export class WidgetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WidgetValidationError'
  }
}

function fail(message: string): never {
  throw new WidgetValidationError(message)
}

function decodeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return '\uFFFD'
  }
  try {
    return String.fromCodePoint(value)
  } catch {
    return '\uFFFD'
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_, dec: string) =>
      decodeCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);?/g, (match, name: string) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()]
      return decoded ?? match
    })
}

/**
 * Normalize JavaScript string escapes before keyword checks.  Inline handlers
 * run after both HTML entity decoding and JS parsing, so `\u0066etch(...)`
 * reaches the engine as `fetch(...)`.
 */
function decodeJsEscapes(value: string): string {
  return value
    .replace(/\\u\{([0-9a-f]+)\}/gi, (_, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16)),
    )
}

/**
 * A reference is self-contained when it is empty, a same-document fragment,
 * an inline data: URI, or about:blank.  Everything else (http, https,
 * protocol-relative, file, blob, javascript, relative paths) needs a fetch.
 */
function isSelfContainedReference(raw: string): boolean {
  const value = decodeEntities(raw).replace(/\s+/g, '')
  if (value === '') return true
  if (value.startsWith('#')) return true
  if (/^data:/i.test(value)) return true
  if (/^about:blank$/i.test(value)) return true
  return false
}

function checkCssUrls(css: string): void {
  for (const match of css.matchAll(CSS_URL_RE)) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    if (!isSelfContainedReference(value)) {
      fail(
        `widget_code loads an external resource via url("${value.trim()}"); inline the asset as a data: URI instead.`,
      )
    }
  }
}

function checkSrcset(value: string): void {
  for (const candidate of value.split(',')) {
    const url = candidate.trim().split(/\s+/)[0] ?? ''
    if (!isSelfContainedReference(url)) {
      fail(
        `widget_code loads an external resource via srcset ("${url}"); inline the asset as a data: URI instead.`,
      )
    }
  }
}

/**
 * Remove the raw text bodies of script and style elements while keeping their
 * opening tags.  Attribute scanning then sees markup, not JavaScript, so a
 * normal assignment such as `const data = { ... }` is not mistaken for a
 * `data` attribute.  Inline event handlers live in opening tags and remain
 * visible.
 */
function markupOnly(code: string): string {
  // The opening-tag body must be quote-aware: `data-x=">"` is a single
  // attribute value, not the end of the tag.  `[^>]*` truncated such tags and
  // let a later src/href escape scanning.
  const tagBody = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*'
  return code
    .replace(
      new RegExp(`(<script\\b${tagBody}>)[\\s\\S]*?<\\/script\\s*>`, 'gi'),
      '$1',
    )
    .replace(
      new RegExp(`(<style\\b${tagBody}>)[\\s\\S]*?<\\/style\\s*>`, 'gi'),
      '$1',
    )
}

function checkAttributes(code: string): void {
  for (const tag of markupOnly(code).matchAll(TAG_RE)) {
    for (const match of tag[0].matchAll(ATTRIBUTE_RE)) {
      const name = match[1]!.toLowerCase()
      const value = match[2] ?? match[3] ?? match[4] ?? ''

      switch (name) {
        case 'src':
        case 'poster':
        case 'data':
        case 'action':
        case 'formaction':
        case 'manifest':
        case 'cite':
          if (!isSelfContainedReference(value)) {
            fail(
              `widget_code loads an external resource via ${name}="${value.trim()}"; inline the asset as a data: URI instead.`,
            )
          }
          break
        case 'href':
        case 'xlink:href':
          if (!isSelfContainedReference(value)) {
            fail(
              `widget_code contains an external URL in href="${value.trim()}"; remove the external link.`,
            )
          }
          break
        case 'srcset':
          checkSrcset(value)
          break
        case 'background':
          if (/url\(/i.test(value)) checkCssUrls(value)
          else if (/^\s*(?:https?:)?\/\//i.test(value)) {
            fail(
              'widget_code loads an external background image; inline the asset as a data: URI instead.',
            )
          }
          break
        default:
          break
      }
    }
  }
}

/**
 * Validate a widget payload and return the code trimmed for fencing.
 *
 * @throws WidgetValidationError when the input is empty, oversized, a full
 *         document, or references anything that is not inline.
 */
export function validateWidgetInput(input: {
  title?: string
  description?: string
  widget_code?: string
}): { title: string; description: string; code: string } {
  const title = (input.title ?? '').trim()
  const description = (input.description ?? '').trim()
  const code = (input.widget_code ?? '').trim()

  if (title === '') fail('title must not be empty.')
  if (code === '') fail('widget_code must not be empty.')
  if (title.length > MAX_TITLE_CHARS) {
    fail(`title must be ${MAX_TITLE_CHARS} characters or fewer.`)
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    fail(`description must be ${MAX_DESCRIPTION_CHARS} characters or fewer.`)
  }
  if (code.length > MAX_WIDGET_CODE_CHARS) {
    fail(
      `widget_code must be ${MAX_WIDGET_CODE_CHARS} characters or fewer; split the visual instead.`,
    )
  }

  if (DOCUMENT_SHELL_RE.test(code)) {
    fail(
      'widget_code must be a fragment: remove <!doctype>, <html>, <head>, and <body>; the host supplies the document shell.',
    )
  }

  if (FENCE_LINE_RE.test(code)) {
    fail(
      'widget_code contains a triple-backtick fence line, which would close the artifact block early.',
    )
  }

  if (
    META_REFRESH_RE.test(code) ||
    META_REFRESH_RE.test(decodeEntities(code))
  ) {
    fail(
      'widget_code must not use a meta refresh, even a same-document or relative one.',
    )
  }

  if (CSS_IMPORT_RE.test(code)) {
    fail('widget_code must not use @import; inline all CSS.')
  }

  // Check raw, entity-decoded, and JS-escape-decoded text.  Inline event
  // handlers are HTML attribute values parsed by both pipelines, so
  // `fetch&#40;` and `\u0066etch(` both arrive as `fetch(`.
  const decodedCode = decodeEntities(code)
  const normalizedCode = decodeJsEscapes(decodedCode)
  for (const [label, pattern] of FORBIDDEN_CONSTRUCTS) {
    if (
      pattern.test(code) ||
      pattern.test(decodedCode) ||
      pattern.test(normalizedCode)
    ) {
      fail(
        `widget_code must not use ${label}; inline all data and behavior in the fragment.`,
      )
    }
  }

  if (
    NAV_OWNER_LOCATION_RE.test(normalizedCode) ||
    NAV_OWNER_OPEN_ACCESS_RE.test(normalizedCode) ||
    NAV_BARE_OPEN_CALL_RE.test(normalizedCode) ||
    hasBareNavigationSink(normalizedCode)
  ) {
    fail(
      'widget_code must not navigate externally; keep the artifact self-contained.',
    )
  }

  checkCssUrls(code)
  checkAttributes(code)

  return { title, description, code }
}

function yamlScalar(value: string): string {
  const line = value.replace(/[\r\n]+/g, ' ').trim()
  if (line === '') return '""'
  const plainSafe =
    /^[A-Za-z0-9][A-Za-z0-9 ._()/-]*$/.test(line) &&
    !/^(?:true|false|null|yes|no|on|off|~)$/i.test(line)
  return plainSafe ? line : JSON.stringify(line)
}

/** Build the single fenced artifact block returned to the host. */
export function buildArtifactFence(
  title: string,
  description: string,
  code: string,
): string {
  const frontmatter = ['---', `title: ${yamlScalar(title)}`]
  if (description !== '') {
    frontmatter.push(`description: ${yamlScalar(description)}`)
  }
  frontmatter.push('---')
  return `\`\`\`artifact-html\n${frontmatter.join('\n')}\n${code}\n\`\`\``
}
