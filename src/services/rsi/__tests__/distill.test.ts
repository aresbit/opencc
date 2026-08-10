import { describe, expect, test } from 'bun:test'
import { readEvidence } from '../estimators.js'
import type { Measurement } from '../ledger.js'
import {
  admitLesson,
  DUPLICATE_THRESHOLD,
  mergeLesson,
  pruneLibrary,
  recallLessons,
  renderSkill,
  retentionScore,
  similarity,
  type Lesson,
} from '../distill.js'

const DAY = 86_400_000

function measurement(passes: number, attempts: number): Measurement {
  return {
    command: 'make sim',
    cwd: '/repo',
    reading: readEvidence(passes, attempts),
    recordedAt: 0,
    treeFingerprint: 'abc',
  }
}

function admit(
  kind: 'worked' | 'failed',
  trigger: string,
  action: string,
  m: Measurement | undefined,
  now = 0,
): Lesson {
  const result = admitLesson({ kind, trigger, action, evidenceRef: 'make sim' }, m, now)
  if (!result.ok) throw new Error(result.error)
  return result.lesson!
}

describe('admitLesson', () => {
  const verified = measurement(40, 40)
  const broken = measurement(0, 10)

  test('admits a success lesson backed by a verified measurement', () => {
    const result = admitLesson(
      {
        kind: 'worked',
        trigger: 'when the grasp controller drifts on soft objects',
        action: 'clamp the force target before the PID stage, not after',
        evidenceRef: 'make sim',
      },
      verified,
    )
    expect(result.ok).toBe(true)
    expect(result.lesson?.evidence).toMatchObject({
      passes: 40,
      attempts: 40,
      verdict: 'verified',
    })
  })

  test('refuses a success lesson when nothing was measured', () => {
    // The filter step is the only thing between this library and a record of
    // whatever felt true at the time.
    const result = admitLesson(
      {
        kind: 'worked',
        trigger: 'when the grasp controller drifts on soft objects',
        action: 'clamp the force target before the PID stage',
        evidenceRef: 'make sim',
      },
      undefined,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Nothing has been measured/)
  })

  test('refuses a success lesson from a merely insufficient run', () => {
    // 5/5 is not a failure and it is not proof either; the four-way verdict
    // exists so this case has somewhere to land.
    const result = admitLesson(
      {
        kind: 'worked',
        trigger: 'when the grasp controller drifts on soft objects',
        action: 'clamp the force target before the PID stage',
        evidenceRef: 'make sim',
      },
      measurement(5, 5),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/on record as insufficient/)
  })

  test('admits a Reflexion note about an actual failure', () => {
    const result = admitLesson(
      {
        kind: 'failed',
        trigger: 'when tempted to widen the joint limits to pass the sim',
        action: 'it makes the sim green and the hardware run unsafe; fix the planner instead',
        evidenceRef: 'make sim',
      },
      broken,
    )
    expect(result.ok).toBe(true)
    expect(result.lesson?.kind).toBe('failed')
  })

  test('refuses a failure note when nothing actually failed', () => {
    // Symmetric to the success gate: a Reflexion note needs a failure, not a
    // suspicion.
    const result = admitLesson(
      {
        kind: 'failed',
        trigger: 'when tempted to widen the joint limits to pass the sim',
        action: 'it makes the sim green and the hardware unsafe',
        evidenceRef: 'make sim',
      },
      verified,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no failure here/)
  })

  test('accepts flaky as grounds for a failure note', () => {
    const result = admitLesson(
      {
        kind: 'failed',
        trigger: 'when the integration suite passes locally but not in CI',
        action: 'the fixture leaks a port; bind to zero and read it back',
        evidenceRef: 'make sim',
      },
      measurement(7, 10),
    )
    expect(result.ok).toBe(true)
  })

  test('rejects a trigger too vague to ever be retrieved', () => {
    const result = admitLesson(
      {
        kind: 'worked',
        trigger: 'bugs',
        action: 'clamp the force target before the PID stage',
        evidenceRef: 'make sim',
      },
      verified,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/trigger of at least/)
  })

  test('rejects an action with no content', () => {
    const result = admitLesson(
      {
        kind: 'worked',
        trigger: 'when the grasp controller drifts on soft objects',
        action: 'fix it',
        evidenceRef: 'make sim',
      },
      verified,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/action of at least/)
  })

  test('rejects a lesson citing no command at all', () => {
    const result = admitLesson(
      {
        kind: 'worked',
        trigger: 'when the grasp controller drifts on soft objects',
        action: 'clamp the force target before the PID stage',
        evidenceRef: '   ',
      },
      verified,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must cite the command/)
  })
})

describe('similarity', () => {
  test('sees a restatement as similar', () => {
    expect(
      similarity(
        'when the grasp controller drifts clamp the force target',
        'clamp the force target when the grasp controller drifts',
      ),
    ).toBe(1)
  })

  test('sees unrelated lessons as dissimilar', () => {
    expect(
      similarity(
        'when the grasp controller drifts clamp the force target',
        'the yaml parser mishandles anchors in the launch file',
      ),
    ).toBeLessThan(0.2)
  })

  test('works on Chinese, where a word tokeniser would not', () => {
    // A word split returns one enormous token for a Chinese sentence and then
    // calls every pair of Chinese lessons completely dissimilar — which would
    // break deduplication exactly in a repository whose notes are Chinese.
    const high = similarity(
      '当抓取控制器在软物体上漂移时先夹紧力目标',
      '先夹紧力目标当抓取控制器在软物体上漂移',
    )
    const low = similarity(
      '当抓取控制器在软物体上漂移时先夹紧力目标',
      '启动文件里的锚点解析有问题',
    )
    expect(high).toBeGreaterThan(0.5)
    expect(low).toBeLessThan(0.2)
  })

  test('is symmetric and zero against nothing', () => {
    expect(similarity('alpha beta', 'beta alpha')).toBe(
      similarity('beta alpha', 'alpha beta'),
    )
    expect(similarity('alpha beta', '')).toBe(0)
  })
})

describe('mergeLesson', () => {
  const m = measurement(40, 40)

  test('adds a genuinely new lesson', () => {
    const first = admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m)
    const second = admit('worked', 'when the launch file fails to resolve anchors', 'inline the anchor instead of referencing it across documents', m)
    const result = mergeLesson([first], second)
    expect(result.outcome).toBe('added')
    expect(result.lessons).toHaveLength(2)
  })

  test('consolidates a restatement instead of appending it', () => {
    // The anti-collapse property: distilling the same insight repeatedly must
    // raise confidence, not volume. Naive appending fills the library with one
    // thought restated forty ways.
    const first = admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m)
    const restated = admit('worked', 'clamp the force target when the grasp controller drifts on soft objects', 'before the PID stage, not after', m)
    const result = mergeLesson([first], restated)
    expect(result.outcome).toBe('confirmed')
    expect(result.lessons).toHaveLength(1)
    expect(result.lessons[0]!.confirmations).toBe(1)
  })

  test('confirmations accumulate across repeated derivations', () => {
    let library: Lesson[] = []
    for (let i = 0; i < 5; i++) {
      const lesson = admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m)
      library = mergeLesson(library, lesson).lessons
    }
    expect(library).toHaveLength(1)
    expect(library[0]!.confirmations).toBe(4)
  })

  test('never merges a success lesson into a failure one', () => {
    const worked = admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m)
    const failed = admit('failed', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', measurement(0, 10))
    const result = mergeLesson([worked], failed)
    expect(result.outcome).toBe('added')
    expect(result.lessons).toHaveLength(2)
  })

  test('a confirmation carries the newest evidence forward', () => {
    const first = admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', measurement(35, 35))
    const again = admit('worked', 'clamp the force target when the grasp controller drifts on soft objects', 'before the PID stage, not after', measurement(60, 60))
    const result = mergeLesson([first], again)
    expect(result.lessons[0]!.evidence.attempts).toBe(60)
  })

  test('the threshold is what decides, and it is exposed', () => {
    expect(DUPLICATE_THRESHOLD).toBeGreaterThan(0)
    expect(DUPLICATE_THRESHOLD).toBeLessThan(1)
  })
})

describe('retentionScore / pruneLibrary', () => {
  const m = measurement(40, 40)

  test('confirmations raise the score', () => {
    const now = 10 * DAY
    const plain = admit('worked', 'when the sim diverges after ten seconds', 'reduce the integrator step before blaming the model', m, now)
    const confirmed = { ...plain, confirmations: 4 }
    expect(retentionScore(confirmed, now)).toBeGreaterThan(
      retentionScore(plain, now),
    )
  })

  test('a stale lesson decays below a fresh one', () => {
    // The stability/plasticity tradeoff, made explicit: a library that only
    // accumulates cannot learn anything new.
    const now = 200 * DAY
    const old: Lesson = {
      ...admit('worked', 'when the sim diverges after ten seconds', 'reduce the integrator step first', m, 0),
      confirmations: 5,
      lastConfirmedAt: 0,
    }
    const fresh = admit('worked', 'when the launch file cannot resolve anchors', 'inline the anchor across documents', m, now)
    expect(retentionScore(old, now)).toBeLessThan(retentionScore(fresh, now))
  })

  test('keeps everything when under the ceiling', () => {
    const lessons = [admit('worked', 'when the sim diverges after ten seconds', 'reduce the integrator step first', m)]
    const result = pruneLibrary(lessons, 10)
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  test('drops the lowest-scoring entries and keeps insertion order', () => {
    const now = 5 * DAY
    const lessons: Lesson[] = [
      { ...admit('worked', 'trigger number one about the simulator', 'action number one about the simulator', m, 0), confirmations: 0, lastConfirmedAt: 0 },
      { ...admit('worked', 'trigger number two about the planner', 'action number two about the planner', m, 0), confirmations: 9, lastConfirmedAt: now },
      { ...admit('worked', 'trigger number three about the driver', 'action number three about the driver', m, 0), confirmations: 3, lastConfirmedAt: now },
    ]
    const result = pruneLibrary(lessons, 2, now)
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]!.trigger).toMatch(/number one/)
    // Order preserved so the rendered file does not churn on every write.
    expect(result.kept[0]!.trigger).toMatch(/number two/)
    expect(result.kept[1]!.trigger).toMatch(/number three/)
  })
})

describe('recallLessons', () => {
  const m = measurement(40, 40)
  const library = [
    admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m),
    admit('worked', 'when the launch file cannot resolve yaml anchors', 'inline the anchor instead of referencing across documents', m),
    admit('failed', 'when tempted to widen joint limits to pass the sim', 'it makes the sim green and the hardware unsafe', measurement(0, 10)),
  ]

  test('surfaces the lesson matching the situation', () => {
    const found = recallLessons(library, 'the grasp controller is drifting again', 1)
    expect(found[0]!.trigger).toMatch(/grasp controller/)
  })

  test('respects the limit', () => {
    expect(recallLessons(library, 'sim', 2)).toHaveLength(2)
  })

  test('falls back to confirmations when nothing matches the query', () => {
    const confirmed = library.map((l, i) =>
      i === 1 ? { ...l, confirmations: 7 } : l,
    )
    const found = recallLessons(confirmed, '', 1)
    expect(found[0]!.trigger).toMatch(/launch file/)
  })

  test('an empty library recalls nothing', () => {
    expect(recallLessons([], 'anything')).toEqual([])
  })
})

describe('renderSkill', () => {
  const m = measurement(40, 40)

  test('produces valid frontmatter the skill loader can read', () => {
    const body = renderSkill([])
    expect(body.startsWith('---\n')).toBe(true)
    expect(body).toMatch(/^name: rsi-lessons$/m)
    expect(body).toMatch(/^description: .+/m)
  })

  test('separates what worked from what failed', () => {
    const body = renderSkill([
      admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m),
      admit('failed', 'when tempted to widen joint limits to pass the sim', 'it makes the sim green and the hardware unsafe', measurement(0, 10)),
    ])
    expect(body).toContain('## What worked')
    expect(body).toContain('## What failed')
    expect(body.indexOf('## What worked')).toBeLessThan(
      body.indexOf('## What failed'),
    )
  })

  test('shows the evidence each lesson rests on', () => {
    const body = renderSkill([
      admit('worked', 'when the grasp controller drifts on soft objects', 'clamp the force target before the PID stage', m),
    ])
    expect(body).toContain('`make sim` measured 40/40 (verified)')
  })

  test('puts the most-confirmed lesson first', () => {
    const one = admit('worked', 'trigger about the simulator diverging', 'action about the integrator step', m)
    const two = {
      ...admit('worked', 'trigger about the planner stalling', 'action about the cost map', m),
      confirmations: 6,
    }
    const body = renderSkill([one, two])
    expect(body.indexOf('planner stalling')).toBeLessThan(
      body.indexOf('simulator diverging'),
    )
    expect(body).toContain('re-derived 6×')
  })

  test('says so when there is nothing yet', () => {
    expect(renderSkill([])).toContain('No lessons have been distilled yet')
  })
})
