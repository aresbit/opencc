/**
 * Era segmentation — where the chronicle's chapters begin and end.
 *
 * This replaces `buildAutoBatches`, which grouped commits by a diff-size score
 * (`files*2 + insertions*0.08 + deletions*0.06`, threshold 22). That is a
 * measure of how many bytes changed, not of what was being built, so a chapter
 * could start and end in the middle of one feature. It also stopped at
 * `maxLectures`, silently covering only a prefix of a long history while the
 * index still reported the full commit count.
 *
 * Here boundaries come from signals that mean something in a project's life:
 * a release, a sustained change in pace, an influx of contributors, a mass
 * rename, a hiatus. Everything in this module is deterministic and pure so it
 * can be tested without a repository or a model — see ./eras.eval.ts. Naming
 * the eras is a separate, narrative step and belongs to the model; drawing the
 * boundaries does not.
 */

export type Commit = {
  hash: string
  shortHash: string
  author: string
  /** ISO date, `YYYY-MM-DD`. */
  date: string
  subject: string
}

export type Tag = {
  name: string
  /** ISO date, `YYYY-MM-DD`. */
  date: string
}

export type BoundaryKind =
  | 'release'
  | 'velocity'
  | 'contributors'
  | 'rewrite'
  | 'dormancy'

export type BoundarySignal = {
  /** Index into `commits` of the first commit of the NEW era. */
  index: number
  kind: BoundaryKind
  /** Human-readable justification, carried into the chapter's front matter. */
  detail: string
}

export type Era = {
  /** 1-based chapter number. */
  ordinal: number
  startIndex: number
  /** Inclusive. */
  endIndex: number
  commits: Commit[]
  startDate: string
  endDate: string
  /** Why this era begins where it does. Empty for the first era. */
  reasons: BoundarySignal[]
}

export type SegmentOptions = {
  /** An era shorter than this is merged into a neighbour. */
  minEraCommits: number
  minEras: number
  maxEras: number
  /** A gap longer than this many days is a hiatus, and a story beat. */
  dormancyDays: number
  /** Fold change in monthly commit rate that counts as a change of pace. */
  velocityRatio: number
  /** Months averaged on each side of a candidate velocity change point. */
  velocityWindowMonths: number
  /** Share of a commit's paths that must be renames to count as a rewrite. */
  renameThreshold: number
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  minEraCommits: 10,
  minEras: 4,
  maxEras: 15,
  dormancyDays: 90,
  velocityRatio: 2,
  velocityWindowMonths: 3,
  renameThreshold: 0.4,
}

export type SegmentInput = {
  /** Chronological, oldest first. */
  commits: Commit[]
  tags?: Tag[]
  /** commit hash → share of changed paths that were renames, 0..1. */
  renameRatio?: ReadonlyMap<string, number>
  options?: Partial<SegmentOptions>
}

// ── date helpers ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

function toTime(isoDate: string): number {
  const t = Date.parse(isoDate)
  return Number.isFinite(t) ? t : NaN
}

function daysBetween(a: string, b: string): number {
  const ta = toTime(a)
  const tb = toTime(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0
  return Math.abs(tb - ta) / DAY_MS
}

/** `YYYY-MM`, the bucket used for every rate calculation. */
function monthKey(isoDate: string): string {
  return isoDate.slice(0, 7)
}

// ── signal detectors ──────────────────────────────────────────────────

/**
 * A release closes an era, so the era begins at the first commit that lands
 * after the tag. Tags dated before the first commit or after the last are
 * ignored rather than clamped: clamping would pile spurious boundaries onto
 * index 0 or the final commit.
 */
export function releaseBoundaries(
  commits: Commit[],
  tags: readonly Tag[],
): BoundarySignal[] {
  const out: BoundarySignal[] = []
  for (const tag of tags) {
    const tagTime = toTime(tag.date)
    if (!Number.isFinite(tagTime)) continue
    const index = commits.findIndex(c => toTime(c.date) > tagTime)
    if (index <= 0) continue
    out.push({
      index,
      kind: 'release',
      detail: `首个位于 ${tag.name}（${tag.date}）之后的提交`,
    })
  }
  return out
}

/**
 * Sustained changes of pace. Comparing single months would fire on every quiet
 * fortnight, so each candidate month is judged by the mean monthly rate over a
 * window on either side.
 */
export function velocityBoundaries(
  commits: Commit[],
  options: SegmentOptions,
): BoundarySignal[] {
  const months = [...new Set(commits.map(c => monthKey(c.date)))].sort()
  const window = options.velocityWindowMonths
  if (months.length < window * 2) return []

  const countByMonth = new Map<string, number>()
  for (const c of commits) {
    const k = monthKey(c.date)
    countByMonth.set(k, (countByMonth.get(k) ?? 0) + 1)
  }
  const rate = (month: string) => countByMonth.get(month) ?? 0
  const mean = (slice: string[]) =>
    slice.length === 0 ? 0 : slice.reduce((s, m) => s + rate(m), 0) / slice.length

  const out: BoundarySignal[] = []
  for (let i = window; i + window <= months.length; i++) {
    const before = mean(months.slice(i - window, i))
    const after = mean(months.slice(i, i + window))
    if (before === 0 && after === 0) continue

    // Guard the ratio against a zero denominator: a project waking up from
    // total silence is the strongest possible acceleration, not a NaN.
    const accelerating = before === 0 || after / before >= options.velocityRatio
    const decelerating = after === 0 || before / after >= options.velocityRatio
    if (!accelerating && !decelerating) continue

    const month = months[i] as string
    const index = commits.findIndex(c => monthKey(c.date) >= month)
    if (index <= 0) continue
    out.push({
      index,
      kind: 'velocity',
      detail: accelerating
        ? `提交速率上升：${before.toFixed(1)} → ${after.toFixed(1)} 次/月（${month} 起）`
        : `提交速率下降：${before.toFixed(1)} → ${after.toFixed(1)} 次/月（${month} 起）`,
    })
  }
  return out
}

/**
 * Two things worth a chapter break: the month a project stops being one
 * person's, and any month that brings in an unusual number of new names.
 */
export function contributorBoundaries(commits: Commit[]): BoundarySignal[] {
  const seen = new Set<string>()
  const newcomersByMonth = new Map<string, string[]>()
  const firstIndexByMonth = new Map<string, number>()

  commits.forEach((c, i) => {
    const month = monthKey(c.date)
    if (!firstIndexByMonth.has(month)) firstIndexByMonth.set(month, i)
    if (!seen.has(c.author)) {
      seen.add(c.author)
      const list = newcomersByMonth.get(month) ?? []
      list.push(c.author)
      newcomersByMonth.set(month, list)
    }
  })

  const out: BoundarySignal[] = []

  // Solo → team: the first commit whose author is not the founding author.
  const founder = commits[0]?.author
  if (founder !== undefined) {
    const index = commits.findIndex(c => c.author !== founder)
    if (index > 0) {
      out.push({
        index,
        kind: 'contributors',
        detail: `${commits[index]?.author} 成为第二位提交者`,
      })
    }
  }

  // An influx: a month bringing at least three new names, and at least twice
  // the typical month's intake.
  const counts = [...newcomersByMonth.values()].map(v => v.length).sort((a, b) => a - b)
  const median = counts.length === 0 ? 0 : (counts[Math.floor(counts.length / 2)] as number)
  for (const [month, newcomers] of newcomersByMonth) {
    if (newcomers.length < 3) continue
    if (newcomers.length < Math.max(2, median * 2)) continue
    const index = firstIndexByMonth.get(month)
    if (index === undefined || index <= 0) continue
    out.push({
      index,
      kind: 'contributors',
      detail: `${month} 有 ${newcomers.length} 位新贡献者加入（${newcomers.slice(0, 3).join('、')}${newcomers.length > 3 ? ' 等' : ''}）`,
    })
  }

  return out
}

/** Mass renames — the shape a rewrite leaves in the history. */
export function rewriteBoundaries(
  commits: Commit[],
  renameRatio: ReadonlyMap<string, number>,
  options: SegmentOptions,
): BoundarySignal[] {
  const out: BoundarySignal[] = []
  commits.forEach((c, i) => {
    if (i === 0) return
    const ratio = renameRatio.get(c.hash)
    if (ratio === undefined || ratio < options.renameThreshold) return
    out.push({
      index: i,
      kind: 'rewrite',
      detail: `${c.shortHash} 中 ${Math.round(ratio * 100)}% 的改动路径为重命名或移动`,
    })
  })
  return out
}

/** A hiatus. The era resumes with the commit that ends it. */
export function dormancyBoundaries(
  commits: Commit[],
  options: SegmentOptions,
): BoundarySignal[] {
  const out: BoundarySignal[] = []
  for (let i = 1; i < commits.length; i++) {
    const prev = commits[i - 1] as Commit
    const cur = commits[i] as Commit
    const gap = daysBetween(prev.date, cur.date)
    if (gap < options.dormancyDays) continue
    out.push({
      index: i,
      kind: 'dormancy',
      detail: `距上一次提交 ${Math.round(gap)} 天（${prev.date} → ${cur.date}）`,
    })
  }
  return out
}

// ── assembly ──────────────────────────────────────────────────────────

function buildEras(commits: Commit[], boundaries: Map<number, BoundarySignal[]>): Era[] {
  const starts = [0, ...[...boundaries.keys()].sort((a, b) => a - b)]
  const eras: Era[] = []
  for (let i = 0; i < starts.length; i++) {
    const startIndex = starts[i] as number
    const endIndex = (i + 1 < starts.length ? (starts[i + 1] as number) : commits.length) - 1
    if (endIndex < startIndex) continue
    const slice = commits.slice(startIndex, endIndex + 1)
    eras.push({
      ordinal: eras.length + 1,
      startIndex,
      endIndex,
      commits: slice,
      startDate: slice[0]?.date ?? '',
      endDate: slice[slice.length - 1]?.date ?? '',
      reasons: boundaries.get(startIndex) ?? [],
    })
  }
  return eras
}

/** Fold era `i` into era `i-1`, keeping the earlier era's opening reasons. */
function mergeInto(eras: Era[], i: number, commits: Commit[]): Era[] {
  if (i <= 0 || i >= eras.length) return eras
  const prev = eras[i - 1] as Era
  const cur = eras[i] as Era
  const merged: Era = {
    ordinal: prev.ordinal,
    startIndex: prev.startIndex,
    endIndex: cur.endIndex,
    commits: commits.slice(prev.startIndex, cur.endIndex + 1),
    startDate: prev.startDate,
    endDate: cur.endDate,
    reasons: prev.reasons,
  }
  const out = [...eras.slice(0, i - 1), merged, ...eras.slice(i + 1)]
  return out.map((e, idx) => ({ ...e, ordinal: idx + 1 }))
}

/**
 * Split the era spanning the longest stretch of time at its midpoint, used
 * only when the signals were too sparse to reach `minEras`. Splitting by time
 * rather than by commit count keeps a long quiet stretch from being reported
 * as one dense chapter.
 */
function splitLongestEra(eras: Era[], commits: Commit[]): Era[] {
  let target = -1
  let bestSpan = -1
  eras.forEach((e, i) => {
    if (e.commits.length < 2) return
    const span = daysBetween(e.startDate, e.endDate)
    if (span > bestSpan) {
      bestSpan = span
      target = i
    }
  })
  if (target < 0) return eras

  const era = eras[target] as Era
  const mid = era.startIndex + Math.floor(era.commits.length / 2)
  if (mid <= era.startIndex || mid > era.endIndex) return eras

  const left: Era = {
    ...era,
    endIndex: mid - 1,
    commits: commits.slice(era.startIndex, mid),
    endDate: (commits[mid - 1] as Commit).date,
  }
  const right: Era = {
    ordinal: 0,
    startIndex: mid,
    endIndex: era.endIndex,
    commits: commits.slice(mid, era.endIndex + 1),
    startDate: (commits[mid] as Commit).date,
    endDate: era.endDate,
    reasons: [
      {
        index: mid,
        kind: 'velocity',
        detail: '按时间跨度均分（信号不足以自然分章）',
      },
    ],
  }
  return [...eras.slice(0, target), left, right, ...eras.slice(target + 1)].map(
    (e, idx) => ({ ...e, ordinal: idx + 1 }),
  )
}

export type Segmentation = {
  eras: Era[]
  /** Every signal found, including ones merged away — shown in the index. */
  signals: BoundarySignal[]
  options: SegmentOptions
}

/**
 * Cut a commit history into eras.
 *
 * Coverage is total by construction: the eras partition the commit list, so
 * unlike the batching this replaces, capping the chapter count merges eras
 * rather than dropping the tail of the history.
 */
export function segmentEras(input: SegmentInput): Segmentation {
  const options = { ...DEFAULT_SEGMENT_OPTIONS, ...(input.options ?? {}) }
  const commits = input.commits

  if (commits.length === 0) {
    return { eras: [], signals: [], options }
  }

  const signals: BoundarySignal[] = [
    ...releaseBoundaries(commits, input.tags ?? []),
    ...velocityBoundaries(commits, options),
    ...contributorBoundaries(commits),
    ...(input.renameRatio
      ? rewriteBoundaries(commits, input.renameRatio, options)
      : []),
    ...dormancyBoundaries(commits, options),
  ].filter(s => s.index > 0 && s.index < commits.length)

  // Several signals often land on the same commit (a release that is also the
  // end of a sprint). Group them so the chapter can report every reason.
  const byIndex = new Map<number, BoundarySignal[]>()
  for (const s of signals) {
    byIndex.set(s.index, [...(byIndex.get(s.index) ?? []), s])
  }

  let eras = buildEras(commits, byIndex)

  // Absorb eras too short to carry a chapter. Walk from the end so indices
  // stay valid as the array shrinks.
  for (let i = eras.length - 1; i > 0; i--) {
    if (eras.length <= options.minEras) break
    if ((eras[i] as Era).commits.length < options.minEraCommits) {
      eras = mergeInto(eras, i, commits)
    }
  }
  // The first era cannot merge backwards, so it gets folded forwards instead.
  if (eras.length > options.minEras && (eras[0] as Era).commits.length < options.minEraCommits) {
    eras = mergeInto(eras, 1, commits)
  }

  // Too many chapters: repeatedly merge the adjacent pair that stays smallest.
  while (eras.length > options.maxEras) {
    let bestAt = 1
    let bestSize = Number.POSITIVE_INFINITY
    for (let i = 1; i < eras.length; i++) {
      const size = (eras[i - 1] as Era).commits.length + (eras[i] as Era).commits.length
      if (size < bestSize) {
        bestSize = size
        bestAt = i
      }
    }
    eras = mergeInto(eras, bestAt, commits)
  }

  // Too few: only worth splitting if there is material to split.
  while (eras.length < options.minEras && commits.length >= options.minEras * 2) {
    const next = splitLongestEra(eras, commits)
    if (next.length === eras.length) break
    eras = next
  }

  return { eras, signals, options }
}
