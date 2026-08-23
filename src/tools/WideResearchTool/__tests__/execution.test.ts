import { afterEach, describe, expect, test } from 'bun:test'
import type { AppState } from '../../../state/AppState.js'
import type { TaskState } from '../../../tasks/types.js'
import { enqueueAgentNotification } from '../../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolUseContext } from '../../../Tool.js'
import {
  appendTaskOutput,
  cleanupTaskOutput,
  initTaskOutput,
} from '../../../utils/task/diskOutput.js'
import {
  resolveAgentResult,
  resolveWideResearchAgentType,
} from '../WideResearchTool.js'

const taskFiles: string[] = []

afterEach(async () => {
  await Promise.all(taskFiles.splice(0).map(id => cleanupTaskOutput(id)))
})

function contextWith(tasks: Record<string, TaskState>): ToolUseContext {
  let state = { tasks } as unknown as AppState
  return {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: update => {
      state = update(state)
    },
  } as ToolUseContext
}

function localTask(overrides: Record<string, unknown>): TaskState {
  return {
    id: 'a-wide',
    type: 'local_agent',
    status: 'completed',
    description: 'wide item',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
    completionOwner: 'wide_research',
    agentId: 'a-wide',
    prompt: 'audit item',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    worktreeFinalized: true,
    result: {
      agentId: 'a-wide',
      content: [{ type: 'text', text: 'finished in background' }],
    },
    ...overrides,
  } as unknown as TaskState
}

describe('resolveAgentResult', () => {
  test('waits for an async agent and returns its final content', async () => {
    const task = localTask({})
    const context = contextWith({ 'a-wide': task })

    const result = await resolveAgentResult(
      { data: { status: 'async_launched', agentId: 'a-wide' } },
      context,
    )

    expect(result).toMatchObject({
      text: 'finished in background',
      agentId: 'a-wide',
    })
    expect(context.getAppState().tasks['a-wide']?.notified).toBe(true)
    expect(
      context.getAppState().tasks['a-wide']?.completionOwner,
    ).toBeUndefined()
  })

  test('suppresses the standalone notification while wide_research owns completion', () => {
    const task = localTask({})
    const context = contextWith({ 'a-wide': task })

    enqueueAgentNotification({
      taskId: 'a-wide',
      description: 'wide item',
      status: 'completed',
      setAppState: context.setAppState,
      finalMessage: 'duplicate',
    })

    expect(context.getAppState().tasks['a-wide']?.notified).toBe(false)
  })

  test('cancels an owned background agent when the parent call is aborted', async () => {
    const task = localTask({ status: 'running', result: undefined })
    const context = contextWith({ 'a-wide': task })
    context.abortController.abort()

    await expect(
      resolveAgentResult(
        { data: { status: 'async_launched', agentId: 'a-wide' } },
        context,
      ),
    ).rejects.toThrow()
    expect(context.getAppState().tasks['a-wide']?.status).toBe('killed')
    expect(context.getAppState().tasks['a-wide']?.notified).toBe(true)
  })

  test('waits for worktree finalization and preserves retained metadata', async () => {
    const task = localTask({ worktreeFinalized: false })
    const context = contextWith({ 'a-wide': task })
    setTimeout(() => {
      context.setAppState(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          'a-wide': {
            ...prev.tasks['a-wide']!,
            worktreeFinalized: true,
            worktreePath: '/tmp/wide-auth',
            worktreeBranch: 'agent-auth',
          } as TaskState,
        },
      }))
    }, 5)

    const result = await resolveAgentResult(
      { data: { status: 'async_launched', agentId: 'a-wide' } },
      context,
    )

    expect(result).toMatchObject({
      worktreePath: '/tmp/wide-auth',
      worktreeBranch: 'agent-auth',
    })
  })

  test('reads the flushed output of a completed remote agent', async () => {
    const taskId = `r-wide-${crypto.randomUUID()}`
    taskFiles.push(taskId)
    await initTaskOutput(taskId)
    appendTaskOutput(taskId, 'remote final answer\n')
    const remote = {
      id: taskId,
      type: 'remote_agent',
      status: 'completed',
      description: 'remote item',
      startTime: Date.now(),
      outputFile: '',
      outputOffset: 0,
      notified: false,
      completionOwner: 'wide_research',
      remoteTaskType: 'remote-agent',
      sessionId: 'session-1',
      command: 'audit remote',
      title: 'remote item',
      todoList: [],
      log: [],
      pollStartedAt: Date.now(),
    } as unknown as TaskState
    const context = contextWith({ [taskId]: remote })

    const result = await resolveAgentResult(
      { data: { status: 'remote_launched', taskId } },
      context,
    )

    expect(result).toMatchObject({
      text: 'remote final answer',
      agentId: taskId,
    })
  })

  test('preserves worktree metadata from synchronous AgentTool results', async () => {
    const result = await resolveAgentResult(
      {
        data: {
          status: 'completed',
          agentId: 'a-sync',
          content: [{ type: 'text', text: 'sync answer' }],
          worktreePath: '/tmp/wide-sync',
          worktreeBranch: 'agent-sync',
        },
      },
      contextWith({}),
    )

    expect(result).toEqual({
      text: 'sync answer',
      agentId: 'a-sync',
      worktreePath: '/tmp/wide-sync',
      worktreeBranch: 'agent-sync',
    })
  })

  test('keeps recoverable worktree metadata when a background agent fails', async () => {
    const task = localTask({
      status: 'failed',
      error: 'verification failed',
      result: undefined,
      worktreePath: '/tmp/wide-failed',
      worktreeBranch: 'agent-failed',
    })

    try {
      await resolveAgentResult(
        { data: { status: 'async_launched', agentId: 'a-wide' } },
        contextWith({ 'a-wide': task }),
      )
      throw new Error('expected resolveAgentResult to reject')
    } catch (error) {
      expect(error).toMatchObject({
        message: 'verification failed',
        worktreePath: '/tmp/wide-failed',
        worktreeBranch: 'agent-failed',
      })
    }
  })
})

describe('resolveWideResearchAgentType', () => {
  const normal = [{ agentType: 'general-purpose' }, { agentType: 'researcher' }]
  const coordinator = [
    { agentType: 'worker' },
    { agentType: 'researcher' },
    { agentType: 'builder' },
  ]

  test('uses general-purpose when normal sessions expose it', () => {
    expect(resolveWideResearchAgentType(undefined, normal)).toBe(
      'general-purpose',
    )
  })

  test('falls back to worker in coordinator and goal environments', () => {
    expect(resolveWideResearchAgentType(undefined, coordinator)).toBe('worker')
    expect(resolveWideResearchAgentType('general-purpose', coordinator)).toBe(
      'worker',
    )
  })

  test('does not silently replace a requested specialised agent', () => {
    expect(resolveWideResearchAgentType('researcher', coordinator)).toBe(
      'researcher',
    )
    expect(
      resolveWideResearchAgentType('missing-specialist', coordinator),
    ).toBe('missing-specialist')
  })
})
