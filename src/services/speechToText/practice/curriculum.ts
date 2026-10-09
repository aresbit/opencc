/**
 * Difficulty control: a small multi-armed bandit over discrete levels whose
 * target is the zone of proximal development — the level the learner succeeds at
 * roughly 60% of the time, i.e. challenging but achievable.
 *
 * Every level carries an EMA of the scores it has produced. Untried levels are
 * explored first; afterwards the pick balances exploitation (EMA closest to the
 * target) against a UCB bonus that shrinks as a level is pulled. Randomness comes
 * from a tiny internal PRNG seeded by the caller, so a run is reproducible.
 */

/** One level's current state, as reported by {@link ZpdBandit.stats}. */
export interface LevelStat {
  level: number
  ema: number
  pulls: number
  ucb: number
}

export interface ZpdBanditOptions {
  /** EMA smoothing factor in (0, 1]. Default 0.3. */
  alpha?: number
  /** UCB exploration constant. Default 0.5. */
  c?: number
  /** The success rate to steer toward. Default 0.6. */
  targetEma?: number
  /** PRNG seed, for reproducible tests. Default 0. */
  seed?: number
}

/** Default difficulty bands. */
export const DEFAULT_LEVELS: number[] = [1, 2, 3, 4, 5, 6, 7, 8]

const EPS = 1e-9

/** mulberry32, with an inspectable/restorable state so serialization is exact. */
class Rng {
  private state: number
  constructor(seed: number) {
    this.state = seed >>> 0
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  getState(): number {
    return this.state
  }
  setState(state: number): void {
    this.state = state >>> 0
  }
}

export class ZpdBandit {
  private levels: number[]
  private alpha: number
  private c: number
  private targetEma: number
  private seed: number
  private rng: Rng
  private ema: Map<number, number>
  private pulls: Map<number, number>

  constructor(levels: number[], opts: ZpdBanditOptions = {}) {
    if (!levels || levels.length === 0) {
      throw new Error('ZpdBandit requires at least one level')
    }
    this.levels = [...levels]
    this.alpha = opts.alpha ?? 0.3
    this.c = opts.c ?? 0.5
    this.targetEma = opts.targetEma ?? 0.6
    this.seed = opts.seed ?? 0
    this.rng = new Rng(this.seed)
    this.ema = new Map(this.levels.map((l) => [l, 0]))
    this.pulls = new Map(this.levels.map((l) => [l, 0]))
  }

  private totalPulls(): number {
    let total = 0
    for (const p of this.pulls.values()) total += p
    return total
  }

  private ucbFor(level: number, total: number): number {
    const pulls = this.pulls.get(level) ?? 0
    if (pulls <= 0 || total <= 1) return 0
    return this.c * Math.sqrt(Math.log(total) / pulls)
  }

  private score(level: number, total: number): number {
    const ema = this.ema.get(level) ?? 0
    const closeness = 1 - Math.abs(ema - this.targetEma)
    return closeness + this.ucbFor(level, total)
  }

  /** Choose the next level: untried first, then the best target-closeness + UCB. */
  pick(): number {
    const untried = this.levels.filter((l) => (this.pulls.get(l) ?? 0) === 0)
    if (untried.length > 0) return untried[0]

    const total = this.totalPulls()
    const scores = this.levels.map((l) => this.score(l, total))
    const max = Math.max(...scores)
    const best = this.levels.filter((_, i) => scores[i] >= max - EPS)
    if (best.length === 1) return best[0]
    return best[Math.floor(this.rng.next() * best.length)]
  }

  /** Fold one observed score (clamped to [0, 1]) into its level's EMA. */
  update(level: number, score: number): void {
    if (!this.ema.has(level)) {
      throw new Error(`unknown level ${level}`)
    }
    const clamped = Math.min(1, Math.max(0, score))
    const prev = this.ema.get(level) ?? 0
    this.ema.set(level, this.alpha * clamped + (1 - this.alpha) * prev)
    this.pulls.set(level, (this.pulls.get(level) ?? 0) + 1)
  }

  stats(): LevelStat[] {
    const total = this.totalPulls()
    return this.levels.map((level) => ({
      level,
      ema: this.ema.get(level) ?? 0,
      pulls: this.pulls.get(level) ?? 0,
      ucb: this.ucbFor(level, total),
    }))
  }

  serialize(): unknown {
    return {
      v: 1,
      levels: [...this.levels],
      alpha: this.alpha,
      c: this.c,
      targetEma: this.targetEma,
      seed: this.seed,
      rngState: this.rng.getState(),
      ema: this.levels.map((l) => this.ema.get(l) ?? 0),
      pulls: this.levels.map((l) => this.pulls.get(l) ?? 0),
    }
  }

  static deserialize(data: unknown): ZpdBandit {
    const d = data as {
      levels?: unknown
      alpha?: unknown
      c?: unknown
      targetEma?: unknown
      seed?: unknown
      rngState?: unknown
      ema?: unknown
      pulls?: unknown
    }
    if (!d || !Array.isArray(d.levels)) {
      throw new Error('ZpdBandit.deserialize: malformed data')
    }
    const levels = d.levels as number[]
    const bandit = new ZpdBandit(levels, {
      alpha: typeof d.alpha === 'number' ? d.alpha : undefined,
      c: typeof d.c === 'number' ? d.c : undefined,
      targetEma: typeof d.targetEma === 'number' ? d.targetEma : undefined,
      seed: typeof d.seed === 'number' ? d.seed : undefined,
    })
    const ema = Array.isArray(d.ema) ? (d.ema as number[]) : []
    const pulls = Array.isArray(d.pulls) ? (d.pulls as number[]) : []
    levels.forEach((level, i) => {
      bandit.ema.set(level, typeof ema[i] === 'number' ? ema[i] : 0)
      bandit.pulls.set(level, typeof pulls[i] === 'number' ? pulls[i] : 0)
    })
    if (typeof d.rngState === 'number') bandit.rng.setState(d.rngState)
    return bandit
  }
}
