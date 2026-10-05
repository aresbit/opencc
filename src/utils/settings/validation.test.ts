import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'
import { filterInvalidHooks } from './validation.js'

/**
 * Regression tests for settings files that contain a hook the build doesn't
 * understand. Before filterInvalidHooks, one unknown hook made
 * SettingsSchema().safeParse fail, so parseSettingsFile returned
 * `settings: null` — discarding the whole file including its `env` block, so
 * ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL never reached process.env and every
 * session reported "not logged in".
 */
describe('filterInvalidHooks', () => {
  test('removes unsupported hook types and keeps supported ones', () => {
    const data = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'not_a_real_hook_type',
                server: 'lcu',
                tool: 'turn_ended',
                input: { a: 'b' },
              },
              { type: 'command', command: 'true' },
            ],
          },
        ],
      },
    }

    const warnings = filterInvalidHooks(data, '/home/u/.claude/settings.json')

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.path).toBe('hooks.Stop')
    expect(warnings[0]?.message).toContain('not_a_real_hook_type')
    expect(data.hooks.Stop[0]?.hooks).toEqual([
      { type: 'command', command: 'true' },
    ])
  })

  test('keeps mcp_tool hooks, which are a supported type', () => {
    const data = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'mcp_tool',
                server: 'lcu',
                tool: 'turn_ended',
                input: { session_id: '${session_id}' },
              },
            ],
          },
        ],
      },
    }

    expect(filterInvalidHooks(data, 'settings.json')).toHaveLength(0)
    expect(data.hooks.Stop[0]?.hooks).toHaveLength(1)
    expect(SettingsSchema().safeParse(data).success).toBe(true)
  })

  test('an unsupported hook no longer poisons the whole settings file', () => {
    const bad = {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'magpie',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'not_a_real_hook_type', server: 's', tool: 't' }],
          },
        ],
      },
    }

    // Without the filter the file is rejected outright.
    expect(SettingsSchema().safeParse(bad).success).toBe(false)

    filterInvalidHooks(bad, 'settings.json')

    // After the filter the file validates and env is preserved.
    const parsed = SettingsSchema().safeParse(bad)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.env?.ANTHROPIC_AUTH_TOKEN).toBe('magpie')
      expect(parsed.data.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3425')
    }
  })

  test('removes unknown event keys', () => {
    const data = {
      env: { A: 'b' },
      hooks: {
        TotallyBogus: [{ hooks: [{ type: 'command', command: 'x' }] }],
      },
    }
    expect(SettingsSchema().safeParse(data).success).toBe(false)

    const warnings = filterInvalidHooks(data, 'settings.json')

    expect(warnings.map(w => w.path)).toEqual(['hooks.TotallyBogus'])
    expect(data.hooks).toEqual({})
    expect(SettingsSchema().safeParse(data).success).toBe(true)
  })

  test('removes a malformed hooks value and non-array matcher lists', () => {
    const arr = { hooks: [], env: { A: 'b' } }
    expect(filterInvalidHooks(arr, 's')).toHaveLength(1)
    expect(SettingsSchema().safeParse(arr).success).toBe(true)

    const nonArray = { hooks: { Stop: 'nope' }, env: { A: 'b' } }
    expect(filterInvalidHooks(nonArray, 's')).toHaveLength(1)
    expect(SettingsSchema().safeParse(nonArray).success).toBe(true)
  })

  test('leaves a fully valid hooks block untouched', () => {
    const data = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] },
        ],
      },
    }
    expect(filterInvalidHooks(data, 'settings.json')).toHaveLength(0)
    expect(data.hooks.Stop[0]?.hooks).toHaveLength(1)
  })

  test('ignores files with no hooks block', () => {
    expect(filterInvalidHooks({ env: { A: 'b' } }, 'settings.json')).toEqual([])
    expect(filterInvalidHooks(null, 'settings.json')).toEqual([])
  })
})
