import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../state/AppStateStore.js'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { getCoordinatorAgents } from '../coordinator/workerAgent.js'
import { inputSchema as agentInputSchema } from '../tools/AgentTool/AgentTool.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../tools/TeamCreateTool/constants.js'
import { TEAM_DELETE_TOOL_NAME } from '../tools/TeamDeleteTool/constants.js'
import { spawnInProcessTeammate } from '../utils/swarm/spawnInProcess.js'
import {
  markMessagesAsRead,
  readMailbox,
  writeToMailbox,
} from '../utils/teammateMailbox.js'
import { blockTask, createTask, listTasks } from '../utils/tasks.js'

let configRoot: string | undefined
const originalConfigRoot = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  if (originalConfigRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigRoot
  if (configRoot) await rm(configRoot, { recursive: true, force: true })
  configRoot = undefined
})

async function useTemporaryConfig(): Promise<void> {
  configRoot = await mkdtemp(join(tmpdir(), 'matebot-components-'))
  process.env.CLAUDE_CONFIG_DIR = configRoot
}

describe('MateBot swarm harness components', () => {
  test('persists a dependency graph on disk', async () => {
    await useTemporaryConfig()
    const graph = 'release-graph'
    const research = await createTask(graph, {
      subject: 'Research',
      description: 'Collect evidence',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    const build = await createTask(graph, {
      subject: 'Build',
      description: 'Implement candidate',
      status: 'pending',
      blocks: [],
      blockedBy: [],
    })
    expect(await blockTask(graph, research, build)).toBe(true)

    const tasks = await listTasks(graph)
    expect(tasks.find(task => task.id === research)?.blocks).toEqual([build])
    expect(tasks.find(task => task.id === build)?.blockedBy).toEqual([research])
  })

  test('serializes concurrent mailbox writers and read state', async () => {
    await useTemporaryConfig()
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeToMailbox(
          'builder',
          {
            from: `peer-${index}`,
            text: `message-${index}`,
            timestamp: new Date(1_700_000_000_000 + index).toISOString(),
          },
          'harness',
        ),
      ),
    )
    const messages = await readMailbox('builder', 'harness')
    expect(messages).toHaveLength(12)
    expect(new Set(messages.map(message => message.text)).size).toBe(12)
    expect(messages.every(message => !message.read)).toBe(true)

    await markMessagesAsRead('builder', 'harness')
    expect(
      (await readMailbox('builder', 'harness')).every(message => message.read),
    ).toBe(true)
  })

  test('registers an addressable in-process teammate', async () => {
    let state = { tasks: {} } as unknown as AppState
    const setAppState = (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    }
    const spawned = await spawnInProcessTeammate(
      {
        name: 'builder',
        teamName: 'harness',
        prompt: 'Implement node 2',
        planModeRequired: false,
      },
      { setAppState },
    )
    expect(spawned.success).toBe(true)
    expect(spawned.agentId).toBe('builder@harness')
    const task = state.tasks[spawned.taskId ?? '']
    expect(task?.type).toBe('in_process_teammate')
    expect(task?.status).toBe('running')
    spawned.abortController?.abort()
    if (task && 'unregisterCleanup' in task) task.unregisterCleanup?.()
  })

  test('exposes Agent, team lifecycle, mailbox and specialist roles', () => {
    expect(
      agentInputSchema().safeParse({
        description: 'remote build',
        prompt: 'Implement a bounded task',
        subagent_type: 'builder',
        isolation: 'remote',
      }).success,
    ).toBe(true)
    expect(COORDINATOR_MODE_ALLOWED_TOOLS).toEqual(
      expect.objectContaining({ size: expect.any(Number) }),
    )
    for (const tool of [
      AGENT_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
      TEAM_CREATE_TOOL_NAME,
      TEAM_DELETE_TOOL_NAME,
    ]) {
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has(tool)).toBe(true)
    }
    expect(getCoordinatorAgents().map(agent => agent.agentType)).toEqual([
      'worker',
      'researcher',
      'planner',
      'builder',
      'evaluator',
    ])
  })
})
