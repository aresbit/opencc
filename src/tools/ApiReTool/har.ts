// HAR parsing + endpoint clustering (deterministic). Semantic auth/param/type
// inference is left to the LLM — this only does what is mechanical.

export interface Request {
  id: number
  method: string
  url: string
  host: string
  path: string
  status: number
  contentType: string
  hasAuthHeader: boolean
  authHeaders: string[]
  queryKeys: string[]
  bodyKeys: string[]
}

export interface Endpoint {
  method: string
  pathPattern: string
  sampleUrl: string
  params: { query: string[]; body: string[] }
  authCandidates: string[]
  statusCodes: number[]
  count: number
}

const STATIC_EXT = /\.(js|css|png|jpe?g|gif|woff2?|ico|svg|map|webp|avif|ttf|eot|mp4|mp3|webm|pdf|zip)(\?|$)/i
const STATIC_MIME = /^(image|font|video|audio|application\/javascript|text\/css|application\/octet-stream)/i

const AUTH_HEADER_RE = /(authorization|cookie|set-cookie|csrf|x-[a-z0-9-]*token|api[-_]?key|token)/i

function headerMap(headers: Array<{ name: string; value: string }>): Map<string, string> {
  const m = new Map<string, string>()
  for (const h of headers ?? []) m.set(h.name.toLowerCase(), h.value)
  return m
}

/** Normalize a URL path by replacing numeric / uuid / hex segments with {param}. */
export function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{uuid}')
    .replace(/\/[0-9a-f]{16,}/gi, '/{id}')
    .replace(/\/\d+(?=\/|$)/g, '/{id}')
}

export function isStatic(req: Request): boolean {
  if (STATIC_EXT.test(req.path)) return true
  if (STATIC_MIME.test(req.contentType)) return true
  return false
}

/** Parse HAR JSON (string or parsed object) into a normalized Request list. */
export function parseHar(input: string | object): Request[] {
  const obj = typeof input === 'string' ? (JSON.parse(input) as any) : input
  const entries: any[] = obj?.log?.entries ?? []
  const requests: Request[] = []
  let id = 0
  for (const e of entries) {
    const req = e?.request
    if (!req) continue
    const url = req.url ?? ''
    let host = ''
    let path = '/'
    try {
      const u = new URL(url)
      host = u.host
      path = u.pathname + u.search
    } catch {
      // non-URL (data:, blob:) — keep path as-is
      path = url
    }
    const headers = headerMap(req.headers ?? [])
    const authHeaders = [...headers.keys()].filter(k => AUTH_HEADER_RE.test(k))
    const queryKeys = (req.queryString ?? []).map((q: any) => String(q.name))
    const bodyKeys: string[] = []
    if (req.postData?.mimeType === 'application/x-www-form-urlencoded' && Array.isArray(req.postData.params)) {
      bodyKeys.push(...req.postData.params.map((p: any) => String(p.name)))
    } else if (req.postData?.mimeType?.includes('json') && req.postData.text) {
      try {
        const j = JSON.parse(req.postData.text)
        if (j && typeof j === 'object') bodyKeys.push(...Object.keys(j))
      } catch {
        // non-JSON body — ignore
      }
    }
    requests.push({
      id: id++,
      method: (req.method ?? 'GET').toUpperCase(),
      url,
      host,
      path,
      status: e?.response?.status ?? 0,
      contentType: e?.response?.content?.mimeType ?? '',
      hasAuthHeader: authHeaders.length > 0,
      authHeaders,
      queryKeys,
      bodyKeys,
    })
  }
  return requests
}

export function clusterEndpoints(requests: Request[]): Endpoint[] {
  const groups = new Map<string, Request[]>()
  for (const r of requests) {
    if (isStatic(r)) continue
    const key = `${r.method} ${normalizePath(r.path)}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }
  const endpoints: Endpoint[] = []
  for (const [key, list] of groups) {
    const method = key.split(' ')[0]
    const pathPattern = key.slice(method.length + 1)
    const query = new Set<string>()
    const body = new Set<string>()
    const auth = new Set<string>()
    const statuses = new Set<number>()
    for (const r of list) {
      r.queryKeys.forEach(k => query.add(k))
      r.bodyKeys.forEach(k => body.add(k))
      r.authHeaders.forEach(h => auth.add(h))
      if (r.status) statuses.add(r.status)
    }
    endpoints.push({
      method,
      pathPattern,
      sampleUrl: list[0].url,
      params: { query: [...query], body: [...body] },
      authCandidates: [...auth],
      statusCodes: [...statuses].sort((a, b) => a - b),
      count: list.length,
    })
  }
  return endpoints.sort((a, b) => b.count - a.count)
}

export function endpointsToMarkdown(endpoints: Endpoint[]): string {
  if (endpoints.length === 0) return '(no endpoints inferred)'
  const lines: string[] = ['| method | path | params (query) | params (body) | auth | status | count |', '|---|---|---|---|---|---|---|']
  for (const e of endpoints) {
    lines.push(
      `| ${e.method} | \`${e.pathPattern}\` | ${e.params.query.join(', ') || '-'} | ${e.params.body.join(', ') || '-'} | ${e.authCandidates.join(', ') || '-'} | ${e.statusCodes.join(',')} | ${e.count} |`,
    )
  }
  return lines.join('\n')
}
