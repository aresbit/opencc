import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActorRuntime } from '../actor/ActorRuntime.js'
import { MateBotRemoteTransport } from './MateBotRemoteTransport.js'
import {
  createMateBotRemoteWorkerServer,
  type MateBotRemoteWorkerServer,
} from './MateBotRemoteWorkerServer.js'

let root: string | undefined
let server: MateBotRemoteWorkerServer | undefined
let transport: MateBotRemoteTransport | undefined

afterEach(async () => {
  transport?.close()
  server?.stop(true)
  transport = undefined
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('MateBot WebSocket remote worker', () => {
  test('launches, streams and completes a remote task', async () => {
    root = await mkdtemp(join(tmpdir(), 'matebot-worker-'))
    const fakeCli = join(root, 'fake-cli.ts')
    await writeFile(
      fakeCli,
      `const prompt = await Bun.stdin.text()
console.log(JSON.stringify({type:'system', subtype:'init', session_id:'fake'}))
console.log(JSON.stringify({type:'result', subtype:'success', is_error:false, duration_ms:1, duration_api_ms:1, num_turns:1, result:'echo:'+prompt, session_id:'fake', total_cost_usd:0, usage:{}}))
`,
    )
    server = createMateBotRemoteWorkerServer({
      hostname: '127.0.0.1',
      port: 0,
      token: 'secret',
      workspaceRoot: root,
      cliPath: fakeCli,
    })
    transport = new MateBotRemoteTransport(server.url, 'secret')

    const launched = await transport.launch({
      description: 'echo task',
      prompt: 'hello swarm',
      role: 'builder',
      cwd: root,
    })
    expect(launched.title).toBe('echo task')

    let batch = await transport.poll(launched.id, null)
    for (
      let attempt = 0;
      attempt < 100 && batch.sessionStatus === 'running';
      attempt++
    ) {
      await Bun.sleep(10)
      batch = await transport.poll(launched.id, null)
    }
    expect(batch.sessionStatus).toBe('completed')
    expect(batch.newEvents.some(event => event.type === 'system')).toBe(true)
    expect(
      batch.newEvents.some(
        event =>
          event.type === 'result' &&
          String((event as { result?: unknown }).result).includes(
            'hello swarm',
          ),
      ),
    ).toBe(true)
  })

  test('rejects unauthorized and out-of-root tasks', async () => {
    root = await mkdtemp(join(tmpdir(), 'matebot-worker-'))
    server = createMateBotRemoteWorkerServer({
      hostname: '127.0.0.1',
      port: 0,
      token: 'secret',
      workspaceRoot: root,
      cliPath: join(root, 'unused.ts'),
    })

    transport = new MateBotRemoteTransport(server.url, 'wrong')
    await expect(
      transport.launch({
        description: 'bad auth',
        prompt: 'noop',
        role: 'builder',
      }),
    ).rejects.toThrow('unauthorized')
    transport.close()

    transport = new MateBotRemoteTransport(server.url, 'secret')
    await expect(
      transport.launch({
        description: 'escape',
        prompt: 'noop',
        role: 'builder',
        cwd: tmpdir(),
      }),
    ).rejects.toThrow('must stay inside worker root')
  })

  test('routes actor envelopes across an IP WebSocket endpoint', async () => {
    root = await mkdtemp(join(tmpdir(), 'matebot-actor-node-'))
    server = createMateBotRemoteWorkerServer({
      hostname: '127.0.0.1',
      port: 0,
      token: 'secret',
      workspaceRoot: root,
    })
    const sender = new ActorRuntime(`${server.url}#harness/sender`, {
      token: 'secret',
    })
    const receiver = new ActorRuntime(`${server.url}#harness/receiver`, {
      token: 'secret',
    })

    await sender.tx(
      receiver.self,
      { command: 'evaluate', node: 3 },
      {
        kind: 'task.command',
        correlationId: 'graph-3',
      },
    )
    const messages = await receiver.rx({ limit: 10 })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe('task.command')
    expect(messages[0]?.correlationId).toBe('graph-3')
    expect(messages[0]?.payload).toEqual({ command: 'evaluate', node: 3 })
    expect(await receiver.rx()).toEqual([])
  })
})
