/**
 * GitHub-user marketplaces.
 *
 * A normal marketplace is one repo that ships `.claude-plugin/marketplace.json`.
 * This module synthesizes a marketplace from a GitHub *account* instead: every
 * source repo the account owns that carries skills becomes one installable
 * plugin entry.
 *
 * That's what a URL like
 *   https://github.com/aresbit?tab=repositories&type=source
 * means to a human, and `parseMarketplaceInput` now maps it to
 *   { source: 'github-user', owner: 'aresbit' }
 *
 * The synthesized manifest is written to the marketplace cache by
 * loadAndCacheMarketplace's `github-user` case, so from that point on the
 * plugin loader, installer and /plugin UI treat it like any other marketplace.
 *
 * Entries are emitted with `strict: false` — a plain skills repo has no
 * `.claude-plugin/plugin.json`, and non-strict means the marketplace entry
 * itself supplies the manifest.
 */

import axios from 'axios'
import { execa } from 'execa'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { isEnvTruthy } from '../envUtils.js'
import { which } from '../which.js'
import type { PluginMarketplace } from './schemas.js'

/**
 * The account whose repositories back the default marketplace.
 * Registered on first open of /plugin — see ensureDefaultSkillMarketplace().
 */
export const DEFAULT_SKILL_MARKETPLACE_OWNER = 'aresbit'

/** Marketplace name for the default account. Plugin ids read `skill@aresbit`. */
export const DEFAULT_SKILL_MARKETPLACE_NAME = DEFAULT_SKILL_MARKETPLACE_OWNER

/** Cap on repo pages fetched (100 repos per page). */
const MAX_REPO_PAGES = 3

/**
 * How many repos we probe for skills concurrently. GitHub's abuse guidance is
 * to stay well under 100 concurrent requests; 16 keeps a ~50-repo account
 * under a few seconds without tripping secondary limits.
 */
const PROBE_CONCURRENCY = 16

const REQUEST_TIMEOUT_MS = 15000

/**
 * Where a repo keeps its skills, which decides what the marketplace entry has
 * to say about it:
 *
 *   'skills-dir'     skills/ at the root — the plugin loader finds it by itself
 *   'claude-skills'  .claude/skills/ — needs an explicit skills path
 *   'root-skill'     a single SKILL.md at the root — skills: ['./']
 *   'plugin'         .claude-plugin/ — a real plugin, its own manifest wins
 *   'none'           nothing skill-shaped
 *   'unknown'        the probe couldn't tell (rate limit, empty repo, blip)
 */
type RepoLayout =
  | 'skills-dir'
  | 'claude-skills'
  | 'root-skill'
  | 'plugin'
  | 'none'
  | 'unknown'

type GitHubRepo = {
  name: string
  full_name: string
  description: string | null
  fork: boolean
  archived: boolean
  disabled?: boolean
  default_branch: string
  pushed_at: string | null
  html_url: string
  topics?: string[]
}

type GitHubContentEntry = {
  name: string
  type: string
}

/**
 * Owner-page URL forms this module understands:
 *   https://github.com/aresbit?tab=repositories&type=source
 *   https://github.com/aresbit/
 *   github.com/aresbit
 *   @aresbit
 *   github-user:aresbit
 *
 * Returns null for anything with a repo path — those stay `source: 'github'`.
 */
export function parseGitHubUserInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Explicit prefix form
  const prefixed = trimmed.match(/^github-user:([^/\s]+)\/?$/i)
  if (prefixed?.[1]) {
    return isValidGitHubUsername(prefixed[1]) ? prefixed[1] : null
  }

  // @owner (no slash — "@scope/pkg" is npm-shaped, not an account)
  const at = trimmed.match(/^@([^/\s]+)$/)
  if (at?.[1]) {
    return isValidGitHubUsername(at[1]) ? at[1] : null
  }

  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : /^(www\.)?github\.com\//i.test(trimmed)
      ? `https://${trimmed}`
      : null
  if (!withScheme) return null

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    return null
  }

  // Exactly one non-empty path segment = an account page, not a repo
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null

  const owner = segments[0]!
  return isValidGitHubUsername(owner) ? owner : null
}

/**
 * GitHub usernames: alphanumerics and single hyphens, max 39 chars.
 * Also rejects reserved first segments that are site pages rather than accounts
 * (github.com/settings, /marketplace, …) so a mistyped URL doesn't silently
 * become a marketplace that 404s on every fetch.
 */
const RESERVED_GITHUB_PATHS = new Set([
  'about',
  'apps',
  'collections',
  'contact',
  'enterprise',
  'events',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'security',
  'settings',
  'sponsors',
  'topics',
  'trending',
])

function isValidGitHubUsername(name: string): boolean {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(name)) {
    return false
  }
  return !RESERVED_GITHUB_PATHS.has(name.toLowerCase())
}

/**
 * A token lifts GitHub's 60 req/hour unauthenticated limit to 5000. Listing an
 * account plus probing its repos is 1+N requests, so an account with a few
 * dozen repos can exhaust the anonymous budget in one go.
 *
 * Resolved once per process: GITHUB_TOKEN / GH_TOKEN, else whatever `gh` is
 * already logged in with. Kept in memory, never logged, only ever sent to
 * api.github.com.
 */
let cachedToken: string | null | undefined

async function resolveGitHubToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken

  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) {
    cachedToken = fromEnv
    return cachedToken
  }

  try {
    const ghPath = await which('gh')
    if (!ghPath) {
      cachedToken = null
      return cachedToken
    }
    const { exitCode, stdout } = await execa('gh', ['auth', 'token'], {
      stderr: 'ignore',
      timeout: 5000,
      reject: false,
    })
    cachedToken = exitCode === 0 && stdout.trim() ? stdout.trim() : null
  } catch {
    cachedToken = null
  }
  return cachedToken
}

async function githubHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const token = await resolveGitHubToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * GitHub answers an exhausted quota with 403 (or 429) plus
 * x-ratelimit-remaining: 0 — a plain 403 on a private repo looks the same
 * without the header, so check it rather than the status alone.
 */
function isRateLimited(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  const status = error.response?.status
  if (status !== 403 && status !== 429) return false
  const remaining = error.response?.headers?.['x-ratelimit-remaining']
  return remaining === undefined || remaining === '0' || remaining === 0
}

/** Human-readable reason + remedy for a failed GitHub API call. */
async function describeGitHubError(
  error: unknown,
  owner: string,
): Promise<string> {
  if (isRateLimited(error)) {
    const hasToken = (await resolveGitHubToken()) !== null
    return hasToken
      ? 'GitHub API rate limit exceeded. Try again later.'
      : 'GitHub API rate limit exceeded for unauthenticated requests. ' +
          'Set GITHUB_TOKEN, or run `gh auth login`, then try again.'
  }
  if (axios.isAxiosError(error) && error.response?.status === 404) {
    return `GitHub account '${owner}' not found.`
  }
  return errorMessage(error)
}

/**
 * List the account's own, non-fork, non-archived repositories.
 * Sorted by last push so the marketplace lists live work first.
 */
async function fetchOwnedRepos(owner: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = []
  const headers = await githubHeaders()

  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const url = `https://api.github.com/users/${encodeURIComponent(owner)}/repos`
    let response
    try {
      response = await axios.get<GitHubRepo[]>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers,
        params: { type: 'owner', sort: 'pushed', per_page: 100, page },
      })
    } catch (error) {
      // Nothing to degrade to on the listing call — without it there is no
      // marketplace at all. Translate to something actionable and rethrow.
      throw new Error(
        `Could not list repositories for github.com/${owner}: ${await describeGitHubError(error, owner)}`,
      )
    }

    const batch = response.data
    if (!Array.isArray(batch)) {
      throw new Error(`Unexpected response listing repositories for ${owner}`)
    }
    repos.push(...batch)
    if (batch.length < 100) break
  }

  // `?type=source` on the profile page means "owned, not a fork"
  return repos.filter(repo => !repo.fork && !repo.archived && !repo.disabled)
}

/** List one directory of a repo. Throws only on rate limiting. */
async function listRepoDirectory(
  repo: GitHubRepo,
  path: string,
  headers: Record<string, string>,
): Promise<GitHubContentEntry[] | null> {
  const url = `https://api.github.com/repos/${repo.full_name}/contents/${path}`
  try {
    const response = await axios.get<GitHubContentEntry[]>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers,
    })
    return Array.isArray(response.data) ? response.data : null
  } catch (error) {
    if (isRateLimited(error)) {
      throw error
    }
    logForDebugging(
      `Listing ${repo.full_name}/${path} failed: ${errorMessage(error)}`,
    )
    return null
  }
}

/**
 * Classify a repo by listing its root tree — cheaper than the git-trees API
 * and enough to tell a skills repo from a random project. Costs a second
 * request only for repos that have a `.claude/` directory and no clearer
 * marker, where the answer is one level down.
 */
async function probeRepoLayout(
  repo: GitHubRepo,
  headers: Record<string, string>,
): Promise<RepoLayout> {
  const entries = await listRepoDirectory(repo, '', headers)
  if (!entries) return 'unknown'

  const dirs = new Set(
    entries.filter(e => e.type === 'dir').map(e => e.name.toLowerCase()),
  )
  const hasRootSkillFile = entries.some(
    e => e.type === 'file' && e.name.toUpperCase() === 'SKILL.MD',
  )

  // Most specific first: a repo with several markers should be treated as the
  // richest thing it is.
  if (dirs.has('.claude-plugin')) return 'plugin'
  if (dirs.has('skills')) return 'skills-dir'
  if (hasRootSkillFile) return 'root-skill'

  if (dirs.has('.claude')) {
    const claudeEntries = await listRepoDirectory(repo, '.claude', headers)
    if (!claudeEntries) return 'unknown'
    if (claudeEntries.some(e => e.type === 'dir' && e.name === 'skills')) {
      return 'claude-skills'
    }
  }

  return 'none'
}

/** Run `task` over `items` with a fixed number of workers, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await task(items[index]!)
      }
    })(),
  )

  await Promise.all(workers)
  return results
}

/**
 * Classify every repo, keeping the ones that carry skills plus any the probe
 * couldn't classify.
 *
 * If the quota runs out mid-probe we stop probing and keep every remaining
 * repo: an over-long list is recoverable (the user ignores the extras), a
 * silently-truncated one is not (the user never learns what's missing).
 */
async function probeRepoLayouts(
  repos: GitHubRepo[],
): Promise<Map<GitHubRepo, RepoLayout>> {
  const headers = await githubHeaders()
  let rateLimited = false

  const layouts = await mapWithConcurrency(
    repos,
    PROBE_CONCURRENCY,
    async (repo): Promise<RepoLayout> => {
      if (rateLimited) return 'unknown'
      try {
        return await probeRepoLayout(repo, headers)
      } catch {
        rateLimited = true
        return 'unknown'
      }
    },
  )

  if (rateLimited) {
    logForDebugging(
      'GitHub rate limit hit while classifying repos — listing unclassified repos too',
      { level: 'warn' },
    )
  }

  return new Map(repos.map((repo, index) => [repo, layouts[index]!]))
}

/**
 * Set CLAUDE_CODE_GITHUB_USER_MARKETPLACE_ALL_REPOS=1 to skip the per-repo
 * skill probe and list every source repo. Trades a clean list for one API call
 * instead of 1+N.
 */
function shouldSkipSkillProbe(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_GITHUB_USER_MARKETPLACE_ALL_REPOS)
}

/**
 * Build the marketplace manifest for a GitHub account.
 *
 * @param owner - GitHub account name
 * @param name - Marketplace name to register under (defaults to the account name)
 * @throws If the account cannot be listed at all (404, network down, rate limited)
 */
export async function fetchGitHubUserMarketplace(
  owner: string,
  name: string = owner,
): Promise<PluginMarketplace> {
  logForDebugging(`Building github-user marketplace for ${owner}`)

  const repos = await fetchOwnedRepos(owner)
  const layouts = shouldSkipSkillProbe()
    ? new Map(repos.map(repo => [repo, 'unknown' as RepoLayout]))
    : await probeRepoLayouts(repos)

  const selected = repos.filter(repo => layouts.get(repo) !== 'none')

  logForDebugging(
    `github-user marketplace ${owner}: ${selected.length}/${repos.length} repos listed`,
  )

  return {
    name,
    owner: {
      name: owner,
      url: `https://github.com/${owner}`,
    },
    plugins: selected.map(repo =>
      buildPluginEntry(repo, layouts.get(repo) ?? 'unknown'),
    ),
    metadata: {
      description: `Skills published by github.com/${owner}`,
    },
  } as PluginMarketplace
}

/**
 * Turn one repo into a marketplace entry.
 *
 * `strict: false` throughout — a plain skills repo has no
 * `.claude-plugin/plugin.json`, so this entry has to serve as the manifest.
 *
 * The extra `skills` paths (manifest paths are repo-relative and must start
 * with "./") cover what the loader would otherwise miss. It already scans
 * `<plugin>/skills` by itself; "./" adds the repo root, which picks up both a
 * single root SKILL.md and the common "one directory per skill at the top
 * level" layout, and costs nothing when neither is there. A repo carrying its
 * own plugin.json is left alone — declaring skills next to a real manifest is
 * a conflict the loader rejects.
 */
function buildPluginEntry(repo: GitHubRepo, layout: RepoLayout) {
  const skillsPaths =
    layout === 'plugin'
      ? undefined
      : layout === 'claude-skills'
        ? ['./', './.claude/skills']
        : ['./']

  return {
    name: repo.name,
    description: repo.description ?? `Skills from github.com/${repo.full_name}`,
    source: { source: 'github' as const, repo: repo.full_name },
    strict: false,
    ...(skillsPaths ? { skills: skillsPaths } : {}),
    ...(repo.topics?.length ? { tags: repo.topics } : {}),
  }
}
