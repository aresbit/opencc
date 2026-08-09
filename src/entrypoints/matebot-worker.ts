import {
  createMateBotRemoteWorkerServer,
  type MateBotRemoteWorkerServer,
} from '../remote/MateBotRemoteWorkerServer.js'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Default to loopback. A worker executes arbitrary prompts as shell-capable
// agent sessions, so exposing it beyond this host has to be a deliberate act.
const hostname = process.env.MATEBOT_WORKER_HOST?.trim() || '127.0.0.1'

let server: MateBotRemoteWorkerServer
try {
  server = createMateBotRemoteWorkerServer({
    hostname,
    port: positiveInteger(process.env.MATEBOT_WORKER_PORT, 8787),
    token: process.env.MATEBOT_WORKER_TOKEN?.trim() || undefined,
    workspaceRoot: process.env.MATEBOT_WORKER_ROOT?.trim() || process.cwd(),
    maxConcurrent: positiveInteger(process.env.MATEBOT_WORKER_CONCURRENCY, 8),
    cliPath: process.env.MATEBOT_WORKER_CLI_PATH?.trim() || undefined,
    permissionMode:
      process.env.MATEBOT_WORKER_PERMISSION_MODE?.trim() || 'acceptEdits',
    actorMailboxRoot: process.env.MATEBOT_WORKER_ACTOR_ROOT?.trim() || undefined,
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

console.log(`MateBot remote worker listening at ${server.url}`)
console.log(
  `Workspace root: ${process.env.MATEBOT_WORKER_ROOT || process.cwd()}`,
)

const shutdown = () => {
  server.stop(true)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
