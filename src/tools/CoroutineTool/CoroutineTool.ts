import { z } from 'zod/v4'
import {
  awaitEvent,
  cancelCoroutine,
  completeCoroutine,
  getCoroutine,
  joinCoroutines,
  listCoroutines,
  renderTree,
  resumeCoroutine,
  sendToCoroutine,
  spawnCoroutine,
} from '../../coroutine/scheduler.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { COROUTINE_TOOL_NAME } from './constants.js'
import { DESCRIPTION } from './prompt.js'

const protocolStep = z.object({
  dir: z.enum(['in', 'out']).describe('out = this coroutine sends; in = it receives.'),
  kind: z.string().min(1).describe('Envelope kind expected at this step.'),
})

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('spawn'),
      task: z.string().optional().describe('Job description; also what the worker is told.'),
      name: z.string().min(1).max(64).optional().describe('Base name; a short id suffix is appended.'),
      worker: z
        .string()
        .min(1)
        .optional()
        .describe('Where the work runs: a subagent/actor address, a session, or name@node. Defaults to the coroutine address itself (you deliver to it).'),
      protocol: z.array(protocolStep).max(32).optional().describe('Advisory session type.'),
      deadline_ms: z.number().int().positive().max(86_400_000).optional(),
      parent_id: z.string().min(1).optional().describe('Parent coroutine id or name; enables recursive cancel.'),
      cwd: z.string().min(1).optional().describe('Directory the coroutine belongs to (cross-directory swarms).'),
      send_task: z.boolean().optional().describe('Deliver the task to the worker now instead of leaving it to the caller.'),
      payload: z.unknown().optional(),
      correlation_id: z.string().optional(),
      goal_id: z
        .string()
        .min(1)
        .optional()
        .describe('Goal this work exists for. Validated first; a mismatch or unknown criterion is refused rather than silently recorded.'),
      criterion_id: z
        .string()
        .min(1)
        .optional()
        .describe('Success criterion on that goal this coroutine must satisfy. Completion evidence is checked against it.'),
    }),
    z.strictObject({
      action: z.literal('send'),
      coroutine: z.string().min(1).describe('Coroutine id or name.'),
      payload: z.unknown().optional(),
      kind: z.string().optional().describe('Defaults to coroutine.message.'),
      correlation_id: z.string().optional(),
      ttl_ms: z.number().int().positive().max(3_600_000).optional(),
      route: z
        .enum(['auto', 'direct', 'swarm'])
        .optional()
        .describe('Delivery layer: auto (default) sends directly to a local address and through SwarmNet to name@node; direct and swarm force one.'),
    }),
    z.strictObject({
      action: z.literal('yield'),
      coroutines: z.array(z.string().min(1)).min(1).max(64),
      expect_kinds: z.array(z.string().min(1)).max(32).optional(),
      from: z.string().min(1).optional().describe('Only this sender completes the wait.'),
      correlation_id: z.string().optional(),
      timeout_ms: z.number().int().min(0).max(600_000).optional(),
      peek_only: z.boolean().optional().describe('Probe without consuming the envelope.'),
    }),
    z.strictObject({
      action: z.literal('select'),
      coroutines: z.array(z.string().min(1)).min(1).max(64),
      expect_kinds: z.array(z.string().min(1)).max(32).optional(),
      from: z.string().min(1).optional(),
      correlation_id: z.string().optional(),
      timeout_ms: z.number().int().min(0).max(600_000).optional(),
      peek_only: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal('resume'),
      coroutine: z.string().min(1),
      value: z.unknown().optional(),
      kind: z.string().optional().describe('Defaults to coroutine.resume.'),
      route: z.enum(['auto', 'direct', 'swarm']).optional(),
    }),
    z.strictObject({
      action: z.literal('join'),
      coroutines: z.array(z.string().min(1)).min(1).max(64),
      timeout_ms: z.number().int().min(0).max(600_000).optional(),
      on: z
        .enum(['terminal', 'verdict'])
        .optional()
        .describe('terminal (default) waits for states; verdict waits for a judgement envelope and acts on it.'),
      verdict_kinds: z
        .array(z.string().min(1))
        .max(16)
        .optional()
        .describe('Envelope kinds that count as a verdict (default: coroutine.verdict).'),
      cancel_on_failure: z
        .boolean()
        .optional()
        .describe('Verdict join: cancel the coroutine subtree when the verdict fails (default true).'),
    }),
    z.strictObject({
      action: z.literal('complete'),
      coroutine: z.string().min(1),
      result: z.unknown().optional(),
      error: z.string().optional().describe('Set an error message to mark it failed.'),
      evidence: z
        .object({
          kind: z.enum(['command', 'file', 'test', 'url', 'observation']),
          ref: z.string().min(1).describe('What was checked: a command, a path, a URL.'),
          note: z.string().optional(),
        })
        .optional()
        .describe('Proof the criterion was met. Admitted by the goal layer — a flaky or stale measurement is rejected, and the coroutine then fails.'),
      criterion_id: z
        .string()
        .min(1)
        .optional()
        .describe('Defaults to the criterion recorded at spawn time.'),
    }),
    z.strictObject({
      action: z.literal('cancel'),
      coroutine: z.string().min(1),
      reason: z.string().optional(),
    }),
    z.strictObject({
      action: z.literal('status'),
      coroutine: z.string().min(1).optional().describe('Show one coroutine instead of the tree.'),
      include_terminal: z.boolean().optional(),
    }),
  ]),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    message: z.string(),
    coroutine: z.unknown().optional(),
    coroutines: z.array(z.unknown()).optional(),
    envelope: z.unknown().optional(),
    /** Which layer carried the last outbound message, and over what path. */
    delivery: z.unknown().optional(),
    cancelled: z.array(z.unknown()).optional(),
    /** yield/select: why the wait ended. */
    reason: z
      .enum(['event', 'timeout', 'aborted', 'terminal', 'no-coroutines'])
      .optional(),
    /** yield/select: the envelope value the wait delivered. */
    matched: z.boolean().optional(),
    waitedMs: z.number().optional(),
    /** complete: the goal admission verdict for supplied evidence. */
    admission: z.unknown().optional(),
    /** complete/cancel: the evolution reflection written for this coroutine. */
    reflection: z.string().optional(),
    /** join on=verdict: what the reviewer said, and what was done about it. */
    verdict: z.unknown().optional(),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>
type Output = z.infer<ReturnType<typeof outputSchema>>

function preview(value: unknown, max = 160): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export const CoroutineTool = buildTool({
  name: COROUTINE_TOOL_NAME,
  searchHint: 'durable suspension point, fan-out wait, cross-agent yield',
  userFacingName: () => 'Coroutine',
  maxResultSizeChars: 120_000,
  get inputSchema(): ReturnType<typeof inputSchema> {
    return inputSchema()
  },
  get outputSchema(): ReturnType<typeof outputSchema> {
    return outputSchema()
  },
  isReadOnly(input) {
    return (
      input.action === 'status' ||
      // A verdict join consumes the verdict, completes or cancels: not a read.
      (input.action === 'join' && input.on !== 'verdict') ||
      ((input.action === 'yield' || input.action === 'select') &&
        Boolean(input.peek_only))
    )
  },
  isConcurrencySafe() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    switch (input.action) {
      case 'spawn':
        return `spawn ${input.task ?? input.name ?? ''}`.trim()
      case 'send':
      case 'resume':
      case 'cancel':
      case 'complete':
        return `${input.action} ${input.coroutine}`
      case 'yield':
      case 'select':
      case 'join':
        return `${input.action} ${input.coroutines.join(',')}`
      case 'status':
        return `status ${input.coroutine ?? ''}`.trim()
    }
  },
  async description() {
    return 'Durable suspension points (coroutines) for a cross-directory, cross-subagent, cross-IP agent swarm: spawn a coroutine on an actor address, yield for its reply, select over several, cancel a subtree.'
  },
  async prompt() {
    return DESCRIPTION
  },
  async call(input, context) {
    switch (input.action) {
      case 'spawn': {
        const result = await spawnCoroutine({
          task: input.task,
          name: input.name,
          worker: input.worker,
          protocol: input.protocol,
          deadlineMs: input.deadline_ms,
          parentId: input.parent_id,
          cwd: input.cwd,
          sendTask: input.send_task,
          payload: input.payload,
          correlationId: input.correlation_id,
          goalId: input.goal_id,
          criterionId: input.criterion_id,
        })
        const record = result.record
        return {
          data: {
            success: true,
            coroutine: record,
            message:
              `Spawned ${record.name} (${record.state}) at ${record.address}` +
              (record.worker && record.worker !== record.address
                ? `, worker ${record.worker}`
                : ', worker is the coroutine itself') +
              (record.deadlineAt ? `, deadline ${record.deadlineAt}` : '') +
              (record.goalId
                ? `, goal ${record.goalId}` +
                  (record.criterionId ? ` / ${record.criterionId}` : '') +
                  (record.subgoalId ? ` as subgoal ${record.subgoalId}` : '')
                : '') +
              `. ${result.detail}`,
          },
        }
      }

      case 'send': {
        const result = await sendToCoroutine(
          {
            coroutine: input.coroutine,
            payload: input.payload,
            kind: input.kind,
            correlationId: input.correlation_id,
            ttlMs: input.ttl_ms,
          },
          { mode: input.route },
        )
        return {
          data: {
            success: true,
            coroutine: result.record,
            delivery: result.delivery,
            message: `Sent [${result.delivery.kind}] to ${result.to} for ${result.record.name}: ${preview(input.payload)} — ${result.delivery.detail}`,
          },
        }
      }

      case 'yield':
      case 'select': {
        const result = await awaitEvent({
          coroutines: input.coroutines,
          expectKinds: input.expect_kinds,
          from: input.from,
          correlationId: input.correlation_id,
          timeoutMs: input.timeout_ms,
          signal: context?.abortController?.signal,
          peekOnly: input.peek_only,
        })
        return {
          data: {
            success: result.reason === 'event',
            matched: result.matched,
            reason: result.reason,
            waitedMs: result.waitedMs,
            coroutine: result.coroutine,
            envelope: result.envelope,
            message: result.matched
              ? `${input.action} matched after ${result.waitedMs}ms: ` +
                `[${result.envelope?.kind}] from ${result.envelope?.from} ` +
                `into ${result.coroutine?.name}: ${preview(result.envelope?.payload)}`
              : `${input.action} ended (${result.reason}) after ${result.waitedMs}ms. ${result.detail}`,
          },
        }
      }

      case 'resume': {
        const result = await resumeCoroutine(
          {
            coroutine: input.coroutine,
            value: input.value,
            kind: input.kind,
          },
          { mode: input.route },
        )
        return {
          data: {
            success: true,
            coroutine: result.record,
            delivery: result.delivery,
            message: `Resumed ${result.record.name} with [${result.delivery.kind}] ${preview(input.value)} (resume #${result.record.resumeCount}) — ${result.delivery.detail}`,
          },
        }
      }

      case 'join': {
        const result = await joinCoroutines({
          coroutines: input.coroutines,
          timeoutMs: input.timeout_ms,
          signal: context?.abortController?.signal,
          on: input.on,
          verdictKinds: input.verdict_kinds,
          cancelOnFailure: input.cancel_on_failure,
        })
        return {
          data: {
            success: result.complete || result.verdict?.ok === true,
            coroutines: result.records,
            waitedMs: result.waitedMs,
            verdict: result.verdict,
            cancelled: result.cancelled,
            message: `${result.complete ? 'Joined' : 'Join finished'} after ${result.waitedMs}ms: ${result.detail}`,
          },
        }
      }

      case 'complete': {
        const result = await completeCoroutine({
          coroutine: input.coroutine,
          result: input.result,
          error: input.error,
          evidence: input.evidence,
          criterionId: input.criterion_id,
        })
        const record = result.record
        return {
          data: {
            success: record.state === 'done',
            coroutine: record,
            admission: result.admission,
            reflection: result.reflection,
            message: `Marked ${record.name} ${record.state}` +
              (record.error ? `: ${record.error}` : '') +
              (record.result !== undefined ? ` — result ${preview(record.result)}` : '') +
              (result.admission?.evidence?.ok
                ? ' (evidence admitted by the goal gate)'
                : result.admission?.evidence
                  ? ` (evidence rejected: ${result.admission.evidence.error ?? 'unknown'})`
                  : '') +
              (result.reflection ? `; reflection ${result.reflection}.` : '.'),
          },
        }
      }

      case 'cancel': {
        const result = await cancelCoroutine({
          coroutine: input.coroutine,
          reason: input.reason,
        })
        return {
          data: {
            success: true,
            coroutine: result.cancelled[0],
            cancelled: result.cancelled,
            message:
              `Cancelled ${result.cancelled.length} coroutine(s)` +
              (input.reason ? ` (${input.reason})` : '') +
              `: ${result.cancelled.map(record => record.name).join(', ')}` +
              `; ${result.delivered} worker(s) notified; subgoals closed as failed.`,
          },
        }
      }

      case 'status': {
        if (input.coroutine) {
          const record = await getCoroutine(input.coroutine)
          if (!record) {
            return {
              data: {
                success: false,
                message: `No coroutine named ${input.coroutine}.`,
              },
            }
          }
          return {
            data: {
              success: true,
              coroutine: record,
              message:
                `${record.name} [${record.state}] ${record.address}` +
                (record.worker ? ` -> worker ${record.worker}` : '') +
                (record.task ? `\n  task: ${record.task}` : '') +
                `\n  protocol ${record.cursor}/${record.protocol.length}, ` +
                `resumes ${record.resumeCount}, children ${record.children.length}` +
                (record.deadlineAt ? `, deadline ${record.deadlineAt}` : '') +
                (record.goalId
                  ? `\n  goal ${record.goalId}` +
                    (record.criterionId ? ` criterion ${record.criterionId}` : '') +
                    (record.subgoalId ? ` subgoal ${record.subgoalId}` : '') +
                    (record.evidence
                      ? ` evidence ${record.evidence.kind}:${record.evidence.ref} (${record.evidence.ok ? 'admitted' : `rejected: ${record.evidence.error ?? 'unknown'}`})`
                      : '')
                  : '') +
                (record.protocolViolations.length
                  ? `\n  violations: ${record.protocolViolations.join(' | ')}`
                  : '') +
                (record.error ? `\n  error: ${record.error}` : '') +
                (record.history.length
                  ? `\n  history:\n` +
                    record.history
                      .slice(-8)
                      .map(event => `    ${event.at} ${event.from} [${event.kind}]${event.violation ? ' ⚠' : ''} ${event.preview}`)
                      .join('\n')
                  : ''),
            },
          }
        }
        const records = await listCoroutines({
          includeTerminal: input.include_terminal,
        })
        return {
          data: {
            success: true,
            coroutines: records,
            message:
              records.length === 0
                ? 'No coroutines in this team.'
                : renderTree(records),
          },
        }
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
  renderToolResultMessage(output: Output) {
    return output.message
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, Output>)
