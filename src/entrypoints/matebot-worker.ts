import { createMateBotRemoteWorkerServer } from '../remote/MateBotRemoteWorkerServer.js'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const server = createMateBotRemoteWorkerServer({
  hostname: process.env.MATEBOT_WORKER_HOST?.trim() || '0.0.0.0',
  port: positiveInteger(process.env.MATEBOT_WORKER_PORT, 8787),
  token: process.env.MATEBOT_WORKER_TOKEN?.trim() || undefined,
  workspaceRoot: process.env.MATEBOT_WORKER_ROOT?.trim() || process.cwd(),
  maxConcurrent: positiveInteger(process.env.MATEBOT_WORKER_CONCURRENCY, 8),
  cliPath: process.env.MATEBOT_WORKER_CLI_PATH?.trim() || undefined,
  permissionMode:
    process.env.MATEBOT_WORKER_PERMISSION_MODE?.trim() || 'acceptEdits',
  actorMailboxRoot: process.env.MATEBOT_WORKER_ACTOR_ROOT?.trim() || undefined,
})

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
