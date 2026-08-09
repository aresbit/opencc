import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearRegisteredHooks,
  registerHookCallbacks,
} from '../bootstrap/state.js'
import { executeWorktreeCreateHook, hasWorktreeCreateHook } from './hooks.js'

function registerCommand(command: string): void {
  registerHookCallbacks({
    WorktreeCreate: [
      {
        hooks: [{ type: 'command', command }],
        pluginRoot: process.cwd(),
        pluginName: 'hook-memory-test',
        pluginId: 'hook-memory-test@local',
      },
    ],
  })
}

describe('bounded command hook output', () => {
  afterEach(() => clearRegisteredHooks())

  test('preserves normal command output', async () => {
    registerCommand("printf '/tmp/generated-worktree'")

    expect(hasWorktreeCreateHook()).toBe(true)
    await expect(executeWorktreeCreateHook('test')).resolves.toEqual({
      worktreePath: '/tmp/generated-worktree',
    })
  })

  test('spills oversized output instead of returning it all', async () => {
    registerCommand(
      `python3 -c "import sys; sys.stdout.write('x' * ${9 * 1024 * 1024})"`,
    )

    const { worktreePath } = await executeWorktreeCreateHook('test')

    expect(worktreePath).toContain('Output truncated')
    expect(worktreePath.length).toBeLessThan(1024)
  })
})
