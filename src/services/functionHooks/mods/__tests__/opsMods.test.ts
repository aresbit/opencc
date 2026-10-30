import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { registry } from '../../registry.js'
import { dispatch } from '../../dispatcher.js'
import type { EngineInterface, HookFn } from '../../types.js'
import { loadMods, resetMods } from '../loader.js'
import { invokeCommand } from '../commands.js'
import { renderDesktopSlots } from '../../desktopSlots.js'

/**
 * The operational mods: kill-guard, cache-stats, swarm-dashboard, skill-index
 * and awr-fleet.
 *
 * They were written against the hook surface, so this drives them through the
 * real loader, the real chains and the real command layer rather than calling
 * `register()` with a fake `on`. Two things are being protected:
 *
 *   - the seams they claim to use still exist and still carry what the mod
 *     reads (`tool.call` with `tool_input`, `usage.record` with `call` and
 *     `context`, `command.invoke` returning a value rather than printing);
 *   - every `CLAUDE_CONFIG_DIR` is honoured per register call, because a
 *     process that changes its config directory must not keep reading the old
 *     one — that is what made these testable at all.
 */

const EXAMPLES = resolve(import.meta.dir, '../../../../../examples/mods')

const $ = {} as EngineInterface
const identity = ((_$: unknown, e: unknown) => e) as HookFn

const roots: string[] = []
let config: string

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ops-mods-'))
  roots.push(dir)
  return dir
}

async function load(): Promise<void> {
  const failed = (await loadMods({ userDir: EXAMPLES, projectDir: EXAMPLES })).filter(r => !r.loaded)
  expect(failed).toEqual([])
}

function slot(plugin: string, slotId: 'panel' | 'composer') {
  return renderDesktopSlots($)[slotId].filter(c => c.pluginId === `mod:${plugin}`)
}

beforeEach(() => {
  config = tempRoot()
  process.env.CLAUDE_CONFIG_DIR = config
})

afterEach(() => {
  resetMods()
  registry.clear()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.AWR_ROSTER
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('kill-guard', () => {
  const call = (command: string) =>
    dispatch($, 'tool.call', { tool_name: 'Bash', tool_input: { command } }, identity) as Promise<
      { deny?: string } | undefined
    >
  const denied = async (command: string) => Boolean((await call(command))?.deny)

  test('a bare numeric kill is refused, one with the lookup is not', async () => {
    await load()
    expect(await denied('kill 1234')).toBe(true)
    expect(await denied('ps -p 1234 -o pid,ppid,cmd; kill 1234')).toBe(false)
    // The PID is not knowable here (`$(cat app.pid)`), so there is nothing to
    // check — and a guard that refuses what it cannot inspect would refuse
    // every pidfile.
    expect(await denied('kill $(cat /run/app.pid)')).toBe(false)
  })

  test('PID 1 and the systemd family are refused whatever the rest of the line', async () => {
    await load()
    expect(await denied('kill 1')).toBe(true)
    expect(await denied('sudo ps -p 1496 -o pid,cmd; kill 1496')).toBe(false)
    expect(await denied('pkill systemd')).toBe(true)
    expect(await denied('pkill -f feishu_bridge.py')).toBe(true)
    expect(await denied('killall5')).toBe(true)
  })

  test('an unbracketed pkill -f is refused, because it matches its own shell', async () => {
    await load()
    expect(await denied("pkill -f '/opt/google/chrome/chrome'")).toBe(true)
    expect(await denied("pkill -f '[/]opt/google/chrome/chrome'")).toBe(false)
  })

  test('text that merely mentions a kill is left alone', async () => {
    await load()
    expect(await denied('echo "kill 1234"')).toBe(false)
    expect(await denied('systemctl --user restart matebot-bridge.service')).toBe(false)
  })

  test('the rules are a command, and are returned rather than printed', async () => {
    await load()
    const result = await invokeCommand($, { command: 'rules', mod: 'kill-guard', source: 'cli' })
    expect(result.ok).toBe(true)
    expect(String(result.value)).toContain('kill-guard refuses')
    expect(String(result.value)).toContain('bracket')
  })
})

describe('cache-stats', () => {
  const usage = (read: number, create: number, input: number) =>
    dispatch(
      $,
      'usage.record',
      {
        model: 'test-model',
        call: {
          inputTokens: input,
          outputTokens: 10,
          cacheReadInputTokens: read,
          cacheCreationInputTokens: create,
          costUSD: 0.01,
        },
        context: { tokens: 575_000, budget: 967_000, percentLeft: 41 },
      },
      identity,
    )

  test('the hit rate is read over the buckets that pay for a prompt', async () => {
    await load()
    await usage(800, 100, 100)
    await usage(900, 0, 100)

    const result = await invokeCommand($, { command: 'stats', mod: 'cache-stats', source: 'cli' })
    const value = result.value as {
      hitRate: number
      session: { calls: number }
      context: { percentLeft: number } | null
    }
    // 1700 read / (1700 read + 100 written + 200 plain input)
    expect(value.hitRate).toBeCloseTo(1700 / 2000, 10)
    expect(value.session.calls).toBe(2)
    expect(value.context?.percentLeft).toBe(41)
  })

  test('the composer badge draws the rate and the gauge', async () => {
    await load()
    await usage(800, 100, 100)
    const [badge] = slot('cache-stats', 'composer')
    const text = JSON.stringify(badge)
    expect(text).toContain('cache hit')
    expect(text).toContain('59% used')
  })

  test('reset clears the day ledger and says so', async () => {
    await load()
    await usage(800, 100, 100)
    const result = await invokeCommand($, { command: 'reset', mod: 'cache-stats', source: 'cli' })
    expect(result.value).toEqual({ cleared: true, day: expect.any(String) })
    const after = await invokeCommand($, { command: 'stats', mod: 'cache-stats', source: 'cli' })
    expect((after.value as { day: { calls: number } }).day.calls).toBe(0)
  })
})

describe('swarm-dashboard', () => {
  function seed(): void {
    mkdirSync(join(config, 'coroutines', 'main'), { recursive: true })
    writeFileSync(
      join(config, 'coroutines', 'main', 'state.json'),
      JSON.stringify({
        coroutines: {
          c1: {
            id: 'c1',
            name: 'review',
            team: 'main',
            state: 'running',
            worker: 'actor://main/reviewer',
            createdAt: new Date().toISOString(),
            task: 'review the diff',
          },
          c2: { id: 'c2', name: 'finished', team: 'main', state: 'done' },
        },
      }),
    )
    mkdirSync(join(config, 'actors', 'main'), { recursive: true })
    writeFileSync(
      join(config, 'actors', 'main', 'peer.presence.json'),
      JSON.stringify({ address: 'actor://main/peer', lastSeenAt: new Date().toISOString() }),
    )
  }

  test('counts every state but lists only the ones still open', async () => {
    seed()
    await load()
    const result = await invokeCommand($, { command: 'show', mod: 'swarm-dashboard', source: 'cli' })
    const value = result.value as {
      counts: Record<string, number>
      coroutines: Array<{ name: string }>
      terminal: number
      alive: number
    }
    expect(value.counts).toEqual({ running: 1, done: 1 })
    expect(value.coroutines.map(c => c.name)).toEqual(['review'])
    expect(value.terminal).toBe(1)
    expect(value.alive).toBe(1)
  })

  test('an empty state directory is a panel that says so, not a crash', async () => {
    await load()
    const [pane] = slot('swarm-dashboard', 'panel')
    expect(JSON.stringify(pane)).toContain('No coroutines or actors on disk yet')
  })
})

describe('skill-index', () => {
  function writeSkill(name: string, description: string): void {
    const dir = join(config, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\nBody.\n`)
  }

  test('finds a skill by the words in a folded description', async () => {
    // `description: >-` is a block scalar, and reading only the indicator line
    // indexes every skill under the literal string ">-". This is that bug.
    writeSkill('trans2zh', '把英文讲义翻译成中文教程，逐章精读并标注来源。')
    await load()

    const result = await invokeCommand($, {
      command: 'find',
      mod: 'skill-index',
      source: 'cli',
      values: { query: '翻译 讲义' },
    })
    const hits = result.value as Array<{ name: string }>
    expect(hits[0]?.name).toBe('trans2zh')
  })

  test('a query nobody wrote a skill for matches nothing', async () => {
    writeSkill('trans2zh', '把英文讲义翻译成中文教程。')
    await load()
    const result = await invokeCommand($, {
      command: 'find',
      mod: 'skill-index',
      source: 'cli',
      values: { query: 'kubernetes operator reconcile' },
    })
    expect(result.value).toEqual([])
  })

  test('rebuild returns the size of the index it walked', async () => {
    writeSkill('trans2zh', '把英文讲义翻译成中文教程。')
    await load()
    const result = await invokeCommand($, { command: 'rebuild', mod: 'skill-index', source: 'cli' })
    const value = result.value as { skills: number; roots: number }
    expect(value.skills).toBeGreaterThanOrEqual(1)
    expect(value.roots).toBe(3)
  })
})

describe('awr-fleet', () => {
  function roster(robots: unknown[], extra: Record<string, unknown> = {}): string {
    const path = join(tempRoot(), 'robots.json')
    writeFileSync(
      path,
      JSON.stringify({ updated_at: new Date().toISOString(), robots, ...extra }),
    )
    return path
  }

  test('the roster is a table, and a sample roster says it is a sample', async () => {
    process.env.AWR_ROSTER = roster(
      [
        { serial_number: 'AWR-01', status: 0, job_status: 0, workspace_id: 'ws-1' },
        { serial_number: 'AWR-02', status: 1, ota: { version: '1.25.8', stage: 'verify', progress: 0.4 } },
      ],
      { sample: true },
    )
    await load()

    const result = await invokeCommand($, { command: 'fleet', mod: 'awr-fleet', source: 'cli' })
    const text = String(result.value)
    expect(text).toContain('AWR-01')
    expect(text).toContain('1.25.8/verify 40%')
    expect(text).toContain('[sample data]')
    expect(JSON.stringify(slot('awr-fleet', 'panel'))).toContain('placeholders, not a live fleet')
  })

  test('a flashing robot counts as OTA in flight; a done one does not', async () => {
    process.env.AWR_ROSTER = roster([
      { serial_number: 'AWR-01', status: 2, job_status: 10 },
      { serial_number: 'AWR-02', status: 0, ota: { stage: 'done' } },
      { serial_number: 'AWR-03', status: 0, ota: { stage: 'flash' } },
    ])
    await load()

    const text = JSON.stringify(slot('awr-fleet', 'panel'))
    expect(text).toContain('ota in flight')
    expect(text).toContain('AWR-03')
  })

  test('an unreadable roster is an error on the panel, not zero robots', async () => {
    process.env.AWR_ROSTER = join(tempRoot(), 'missing.json')
    await load()

    const text = JSON.stringify(slot('awr-fleet', 'panel'))
    expect(text).toContain('Cannot read')
    const result = await invokeCommand($, { command: 'fleet', mod: 'awr-fleet', source: 'cli' })
    expect(String(result.value)).toContain('error:')
  })
})
