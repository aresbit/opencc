/**
 * GitHub metadata for the chronicle's second track.
 *
 * A chronicle written from commits alone records what was built but not what
 * was argued about. The community line comes from issues and pull requests:
 * the threads with the most comments are where the project's contested
 * decisions actually happened, and pairing them with the commits that followed
 * is the 互文时刻 the narrative is built around.
 *
 * Two things learned from the real API rather than assumed:
 *
 *   - `gh issue list --json comments` returns every comment's full body. Three
 *     issues of `tj/n` came back as ~8 KB; five hundred would be megabytes and
 *     would blow any context budget. The REST endpoint reports `comments` as
 *     an integer instead, so ranking is cheap and only the selected few
 *     threads are fetched in full.
 *   - REST `/issues` mixes pull requests in with issues — one of the first
 *     three items from `tj/n` was a PR. They are told apart by the presence of
 *     a `pull_request` key, not by anything in the number or title.
 *
 * Nothing here throws. `gh` may be missing, unauthenticated, rate-limited, or
 * pointed at a repository that has no issues at all; in every case the
 * chronicle continues from git alone and records the gap, because a missing
 * source has to be visible in the finished document rather than silently
 * shrinking it.
 */

export type GhIssue = {
  number: number
  title: string
  state: 'open' | 'closed'
  createdAt: string
  closedAt: string | null
  /** Comment count — the discussion-heat signal used for ranking. */
  comments: number
  author: string
  isPr: boolean
}

export type GhRelease = {
  tag: string
  name: string
  publishedAt: string
  body: string
}

export type GhData = {
  available: boolean
  /** Why GitHub data is missing, for the methodology note. */
  reason?: string
  releases: GhRelease[]
  issues: GhIssue[]
}

export const EMPTY_GH_DATA: GhData = { available: false, releases: [], issues: [] }

/** Release bodies are quoted in chapters; keep one from swamping a page. */
const RELEASE_BODY_BUDGET = 2_000

// ── subprocess ────────────────────────────────────────────────────────

async function runGh(
  args: string[],
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const proc = Bun.spawn(['gh', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
    })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    if (code !== 0) {
      return { ok: false, error: stderr.trim() || `gh exited ${code}` }
    }
    return { ok: true, stdout }
  } catch (e) {
    // Most often ENOENT: gh is not installed.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function ghStatus(
  signal: AbortSignal,
): Promise<{ available: boolean; reason?: string }> {
  const r = await runGh(['auth', 'status'], signal, 15_000)
  if (!r.ok) {
    return {
      available: false,
      reason: /enoent|not found/i.test(r.error)
        ? 'gh CLI 未安装，本次编年史仅使用 git 数据'
        : `gh 不可用（${r.error.split('\n')[0]}），本次编年史仅使用 git 数据`,
    }
  }
  return { available: true }
}

// ── parsing (pure) ────────────────────────────────────────────────────

/**
 * Map one REST issue object to our shape.
 *
 * Returns null for anything missing a number, rather than emitting a
 * zero-numbered placeholder that would later render as a citation `i:0`
 * pointing at nothing.
 */
export function projectIssue(raw: unknown): GhIssue | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const number = typeof o.number === 'number' ? o.number : Number.NaN
  if (!Number.isFinite(number) || number <= 0) return null
  const user = o.user as { login?: unknown } | undefined
  return {
    number,
    title: typeof o.title === 'string' ? o.title : '',
    state: o.state === 'closed' ? 'closed' : 'open',
    createdAt: typeof o.created_at === 'string' ? o.created_at.slice(0, 10) : '',
    closedAt: typeof o.closed_at === 'string' ? o.closed_at.slice(0, 10) : null,
    comments: typeof o.comments === 'number' ? o.comments : 0,
    author: typeof user?.login === 'string' ? user.login : '',
    // The only reliable discriminator: REST serves PRs from /issues too.
    isPr: Object.hasOwn(o, 'pull_request'),
  }
}

export function parseIssuesJson(stdout: string): GhIssue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(projectIssue).filter((i): i is GhIssue => i !== null)
}

export function parseReleasesJson(stdout: string): GhRelease[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(raw => {
      if (raw === null || typeof raw !== 'object') return null
      const o = raw as Record<string, unknown>
      const tag = typeof o.tagName === 'string' ? o.tagName : ''
      if (!tag) return null
      const body = typeof o.body === 'string' ? o.body : ''
      return {
        tag,
        name: typeof o.name === 'string' && o.name ? o.name : tag,
        publishedAt: typeof o.publishedAt === 'string' ? o.publishedAt.slice(0, 10) : '',
        body:
          body.length > RELEASE_BODY_BUDGET
            ? `${body.slice(0, RELEASE_BODY_BUDGET)}\n[…发布说明截断]`
            : body,
      }
    })
    .filter((r): r is GhRelease => r !== null)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
}

// ── selection (pure) ──────────────────────────────────────────────────

/** Issues and PRs opened within a calendar window, oldest first. */
export function inWindow(
  issues: readonly GhIssue[],
  startDate: string,
  endDate: string,
): GhIssue[] {
  return issues
    .filter(i => i.createdAt && i.createdAt >= startDate && i.createdAt <= endDate)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * The threads worth reading in full: most-discussed first.
 *
 * Comment count is a proxy for contention, which is what the community track
 * needs. Ties break toward the older thread, so a long-running argument
 * outranks a recent one with the same volume.
 */
export function rankByDiscussion(issues: readonly GhIssue[], top: number): GhIssue[] {
  return [...issues]
    .filter(i => i.comments > 0)
    .sort((a, b) => b.comments - a.comments || a.createdAt.localeCompare(b.createdAt))
    .slice(0, top)
}

export type IntertextualMoment = {
  issue: GhIssue
  /** The commit that answered it. */
  commitHash: string
  commitShortHash: string
  commitDate: string
  commitSubject: string
  /** Days from the issue being opened to the commit landing. */
  latencyDays: number
}

/**
 * Find the moments where a discussion turned into code.
 *
 * A commit whose message cites issue N, landing after N was opened, is the
 * strongest evidence a chronicle can offer that the community moved the
 * project — it is a claim about causation backed by two dated records rather
 * than by narration.
 *
 * The ordering test is what makes it evidence: a commit that mentions an issue
 * opened *later* is a coincidence of numbering, not an answer to it, so those
 * are discarded rather than reported as influence.
 */
export function findIntertextualMoments(
  issues: readonly GhIssue[],
  commits: readonly {
    hash: string
    shortHash: string
    date: string
    subject: string
    /** Every `#N` in the message — see git.ts extractAllRefs. */
    refs: number[]
  }[],
  limit = 10,
): IntertextualMoment[] {
  const byNumber = new Map(issues.map(i => [i.number, i]))
  const out: IntertextualMoment[] = []
  const seen = new Set<string>()

  for (const c of commits) {
    // Every reference is considered, not just the PR that carried the commit:
    // "Merge pull request #123 … Closes #99" is a commit about issue 99.
    for (const ref of c.refs) {
      const issue = byNumber.get(ref)
      // A PR is its own thread; the interesting case is a commit answering an
      // issue someone else raised.
      if (!issue || issue.isPr) continue
      if (!issue.createdAt || !c.date) continue
      if (c.date < issue.createdAt) continue
      const latencyDays = Math.round(
        (Date.parse(c.date) - Date.parse(issue.createdAt)) / 86_400_000,
      )
      if (!Number.isFinite(latencyDays) || latencyDays < 0) continue
      // One commit can close several issues; one issue can be touched by
      // several commits. Report each pair once.
      const key = `${issue.number}:${c.hash}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        issue,
        commitHash: c.hash,
        commitShortHash: c.shortHash,
        commitDate: c.date,
        commitSubject: c.subject,
        latencyDays,
      })
    }
  }

  // Most-discussed first: a one-comment issue closed by a commit is routine,
  // a forty-comment argument that finally landed is the story.
  return out
    .sort((a, b) => b.issue.comments - a.issue.comments || a.commitDate.localeCompare(b.commitDate))
    .slice(0, limit)
}

// ── collection ────────────────────────────────────────────────────────

export type FetchOptions = {
  /** `owner/repo`. */
  repo: string
  signal: AbortSignal
  /** Upper bound on issues+PRs pulled. Old projects have tens of thousands. */
  maxIssues?: number
}

/**
 * Pull releases, issues and PRs.
 *
 * Paging is bounded and explicit: `gh api --paginate` would happily walk
 * 20,000 issues on an old repository, so pages are requested one at a time up
 * to `maxIssues` and the shortfall is reported rather than hidden.
 */
export async function fetchGitHubData(opts: FetchOptions): Promise<GhData> {
  const maxIssues = opts.maxIssues ?? 500
  const status = await ghStatus(opts.signal)
  if (!status.available) {
    return { ...EMPTY_GH_DATA, reason: status.reason }
  }

  // `body` is not among the fields `gh release list` serves — asking for it
  // fails the whole call, which silently produced zero releases. Bodies come
  // from `gh release view` per tag, and only for the ones actually quoted.
  const releasesRaw = await runGh(
    ['release', 'list', '--repo', opts.repo, '--limit', '200', '--json', 'tagName,publishedAt,name'],
    opts.signal,
  )
  const releases = releasesRaw.ok ? parseReleasesJson(releasesRaw.stdout) : []

  const issues: GhIssue[] = []
  const perPage = 100
  const maxPages = Math.ceil(maxIssues / perPage)
  let truncated = false
  for (let page = 1; page <= maxPages; page++) {
    const r = await runGh(
      [
        'api',
        // Ascending by creation date, deliberately. REST defaults to
        // newest-first, so capping the fetch on a fifteen-year-old project
        // returned only recent issues and left the early years — the part a
        // "from zero to one" chronicle is mostly about — with no community
        // record at all.
        `repos/${opts.repo}/issues?state=all&per_page=${perPage}&page=${page}&sort=created&direction=asc`,
      ],
      opts.signal,
    )
    if (!r.ok) break
    const batch = parseIssuesJson(r.stdout)
    issues.push(...batch)
    if (batch.length < perPage) break
    if (page === maxPages) truncated = true
  }

  const notes: string[] = []
  if (!releasesRaw.ok) {
    notes.push(`release 列表拉取失败（${releasesRaw.error.split('\n')[0]}）`)
  }
  if (truncated) {
    notes.push(`issue/PR 仅抓取最早 ${issues.length} 条（上限 ${maxIssues}），更晚的未覆盖`)
  }

  return {
    available: true,
    reason: notes.length > 0 ? notes.join('；') : undefined,
    releases,
    issues,
  }
}

/**
 * Fetch one release's notes.
 *
 * Separate from the listing because `gh release list --json body` is rejected
 * outright — `body` is not among the fields that endpoint serves, and asking
 * for it failed the whole call, which is why releases silently came back empty
 * until a live run caught it. Called only for the releases a chapter quotes.
 */
export async function fetchReleaseBody(
  repo: string,
  tag: string,
  signal: AbortSignal,
): Promise<string> {
  const r = await runGh(
    ['release', 'view', tag, '--repo', repo, '--json', 'body'],
    signal,
    30_000,
  )
  if (!r.ok) return ''
  try {
    const body = (JSON.parse(r.stdout) as { body?: unknown }).body
    if (typeof body !== 'string') return ''
    return body.length > RELEASE_BODY_BUDGET
      ? `${body.slice(0, RELEASE_BODY_BUDGET)}\n[…发布说明截断]`
      : body
  } catch {
    return ''
  }
}

export type IssueThread = {
  number: number
  title: string
  /** Opening comment, truncated. */
  body: string
  /** Last comment, which is usually where the decision landed. */
  lastComment: string
}

/** Per-comment budget when a thread is read in full. */
const COMMENT_BUDGET = 1_200

function clip(text: string, budget = COMMENT_BUDGET): string {
  const flat = text.trim()
  return flat.length > budget ? `${flat.slice(0, budget)}…` : flat
}

/**
 * Read one thread in full. Called only for the handful of issues selected by
 * `rankByDiscussion`, which is what keeps the comment bodies affordable.
 */
export async function fetchIssueThread(
  repo: string,
  number: number,
  signal: AbortSignal,
): Promise<IssueThread | null> {
  const r = await runGh(
    ['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,body,comments'],
    signal,
  )
  if (!r.ok) return null
  try {
    const o = JSON.parse(r.stdout) as Record<string, unknown>
    const comments = Array.isArray(o.comments) ? o.comments : []
    const last = comments[comments.length - 1] as { body?: unknown } | undefined
    return {
      number: typeof o.number === 'number' ? o.number : number,
      title: typeof o.title === 'string' ? o.title : '',
      body: clip(typeof o.body === 'string' ? o.body : ''),
      lastComment: clip(typeof last?.body === 'string' ? last.body : ''),
    }
  } catch {
    return null
  }
}
