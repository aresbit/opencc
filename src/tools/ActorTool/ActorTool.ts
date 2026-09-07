import { z } from 'zod/v4'
import {
  createCurrentActorRuntime,
  getCurrentActorAddress,
} from '../../actor/currentActor.js'
import { LocalActorMailbox } from '../../actor/LocalActorMailbox.js'
import { ActorResourceRegistry } from '../../actor/ActorResourceRegistry.js'
import { parseActorAddress } from '../../actor/types.js'
import { getEngine } from '../../services/functionHooks/bridge.js'
import {
  buildTool,
  type ToolDef,
  type ToolInputJSONSchema,
} from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import {
  getAgentName,
  getTeammateColor,
  getTeamName,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { flattenUnionSchema } from '../MemoryTool/flattenSchema.js'
import { ACTOR_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('self') }),
    z.object({
      action: z.literal('peers'),
      team: z
        .string()
        .optional()
        .describe('Optional team name filter. Defaults to all announced local actors.'),
    }),
    z.object({
      action: z.literal('tx'),
      to: z
        .string()
        .min(1)
        .describe('actor://team/name, team-local name, or ws(s)://host/ws#team/name.'),
      payload: z.unknown().optional(),
      kind: z.string().optional().describe('Versioned envelope kind.'),
      correlation_id: z
        .string()
        .optional()
        .describe('Stable request/reply or task correlation id.'),
      ttl_ms: z.number().int().positive().optional(),
    }),
    z.object({
      action: z.literal('rx'),
      timeout_ms: z.number().int().min(0).max(30_000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    z.object({
      action: z.literal('resource_offer'),
      resource_id: z.string().min(1).max(128),
      capacity: z.number().int().min(1).max(1_000_000).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({ action: z.literal('resource_list') }),
    z.object({
      action: z.literal('resource_acquire'),
      resource_id: z.string().min(1).max(128),
      units: z.number().int().positive().optional(),
      ttl_ms: z.number().int().min(1_000).max(86_400_000).optional(),
      note: z.string().optional(),
    }),
    z.object({
      action: z.literal('resource_release'),
      lease_id: z.string().min(1),
    }),
  ]),
)

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    self: z.string(),
    envelope: z.unknown().optional(),
    envelopes: z.array(z.unknown()).optional(),
    peers: z
      .array(
        z.object({
          address: z.string(),
          unread: z.number(),
          lastSeenAt: z.string().optional(),
        }),
      )
      .optional(),
    resources: z.array(z.unknown()).optional(),
    resource: z.unknown().optional(),
    lease: z.unknown().optional(),
    message: z.string(),
  }),
)

type Input = z.infer<ReturnType<typeof inputSchema>>
type Output = z.infer<ReturnType<typeof outputSchema>>
const PEER_STALE_AFTER_MS = 10 * 60 * 1000

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'function') return '<lambda>'
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function formatResourceList(listed: any[]): string {
  return listed.length
    ? listed
        .map(
          (resource: any) =>
            `${resource.id}: ${resource.available}/${resource.capacity} available; owner=${resource.owner}` +
            (resource.leases.length
              ? `; leases=${resource.leases.map((lease: any) => `${lease.holder}:${lease.units} until ${lease.expiresAt}`).join(', ')}`
              : ''),
        )
        .join('\n')
    : 'No shared compute resources have been offered.'
}

function formatEnvelopes(envelopes: any[]): string {
  return envelopes.length
    ? `Received ${envelopes.length} envelope(s):\n${envelopes
        .map(
          (envelope: any) =>
            `- ${envelope.from} -> ${envelope.to} [${envelope.kind}${envelope.correlationId ? ` #${envelope.correlationId}` : ''}] ${preview(envelope.payload)}`,
        )
        .join('\n')}`
    : 'No actor envelopes received.'
}

function preview(value: unknown, max = 160): string {
  const rendered =
    typeof value === 'string' ? value : JSON.stringify(jsonSafe(value))
  return rendered.length <= max ? rendered : `${rendered.slice(0, max)}…`
}

export const ActorTool = buildTool({
  name: ACTOR_TOOL_NAME,
  aliases: ['actor', 'actor_tool'],
  searchHint:
    'visible agent tx rx conversation cross-directory compute resource lease coordination',
  shouldDefer: false,
  maxResultSizeChars: 100_000,
  async description() {
    return 'Visible actor coordination across directories: discover peers, inspect tx/rx conversations, and atomically offer/acquire/release shared compute resource leases.'
  },
  async prompt() {
    return `Use ActorTool for visible coordination between agents in different directories/processes. Actor traffic is not a hidden side channel: every tx call shows its destination, kind, correlation id and payload in the transcript; every rx result shows the received envelopes; automatically delivered envelopes enter the recipient's normal conversation as <actor-message> content.

Call action="peers" before tx when the destination is unknown. action="self" returns and announces this actor address. action="tx" sends a durable envelope; action="rx" atomically claims envelopes and can wait up to 30 seconds. Use correlation_id for request/reply threads.

For shared compute across local checkouts/worktrees:
- resource_offer publishes a named resource and integer capacity (for example gpu:0 capacity 1, cpu-heavy capacity 4).
- resource_list shows capacity, available units, holders, notes and expiry.
- resource_acquire atomically obtains units with a TTL lease; contention fails with the current holders instead of oversubscribing.
- resource_release returns a lease. Acquire/release also send a visible resource event to the resource owner.

Addresses are actor://team/name locally or ws://host:port/ws#team/name remotely. SICP meta-evaluation belongs to eval_apply, not this communication tool.`
  },
  get inputSchema() {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema(), { io: 'input' })
    if (!isFirstPartyAnthropicBaseUrl()) {
      return flattenUnionSchema(schema, 'action') as ToolInputJSONSchema
    }
    schema.type = 'object'
    return schema as ToolInputJSONSchema
  },
  get outputSchema() {
    return outputSchema()
  },
  userFacingName() {
    return 'Actor'
  },
  isConcurrencySafe(input) {
    return (
      input.action === 'self' ||
      input.action === 'peers' ||
      input.action === 'resource_list'
    )
  },
  isReadOnly(input) {
    return (
      input.action === 'self' ||
      input.action === 'peers' ||
      input.action === 'resource_list'
    )
  },
  interruptBehavior() {
    return 'cancel'
  },
  renderToolUseMessage(input: Partial<Input>) {
    if (!input.action) return null
    if (input.action === 'tx') {
      const correlation = input.correlation_id
        ? ` #${input.correlation_id}`
        : ''
      return `tx ${input.to ?? '?'} [${input.kind ?? 'message'}${correlation}] ${preview(input.payload ?? null)}`
    }
    if (input.action === 'rx') {
      return `rx wait=${input.timeout_ms ?? 0}ms limit=${input.limit ?? 1}`
    }
    if (input.action === 'resource_offer') {
      return `offer ${input.resource_id ?? '?'} capacity=${input.capacity ?? 1}`
    }
    if (input.action === 'resource_acquire') {
      return `acquire ${input.resource_id ?? '?'} units=${input.units ?? 1}`
    }
    if (input.action === 'resource_release') {
      return `release ${input.lease_id ?? '?'}`
    }
    return `actor ${input.action}`
  },
  async call(input: Input, context) {
    const $ = getEngine()
    const self = getCurrentActorAddress()

    // Announce on every action so peers discover us even without the
    // background inbox poller.
    const mailbox = new LocalActorMailbox()
    await mailbox.announce(self)

    // ── Dispatch through $.actor.* when the engine is up ──
    // Each branch delegates to the engine noun, which runs the hook chain
    // (mprotect, audit, rate-limit, …) with ActorRuntime at ⊥.
    // Falls back to direct runtime calls when the engine hasn't booted.

    if (input.action === 'self') {
      if ($?.actor) {
        const result = await $.actor.self({ address: self })
        return { data: result }
      }
      return {
        data: { success: true, self, message: `Actor address: ${self}` },
      }
    }
    if (input.action === 'peers') {
      if ($?.actor) {
        const result = await $.actor.peers({ address: self, team: input.team, staleAfterMs: PEER_STALE_AFTER_MS })
        return { data: result }
      }
      const peers = (await mailbox.list()).filter(entry => {
        if (entry.address !== self && entry.lastSeenAt && Date.now() - Date.parse(entry.lastSeenAt) > PEER_STALE_AFTER_MS) return false
        if (!input.team?.trim()) return true
        return parseActorAddress(entry.address).team === input.team.trim()
      })
      return {
        data: {
          success: true, self, peers,
          message: peers.length
            ? `Peers:\n${peers.map(peer => `- ${peer.address} (${peer.unread} unread)`).join('\n')}`
            : 'No announced actor peers.',
        },
      }
    }
    if (input.action === 'resource_offer') {
      if ($?.actor) {
        const resource = await $.actor.resource_offer({ address: self, resourceId: input.resource_id, capacity: input.capacity, metadata: input.metadata })
        return {
          data: {
            success: true, self, resource,
            message: `Offered ${resource.id}: ${resource.available}/${resource.capacity} units available (owner ${resource.owner})`,
          },
        }
      }
      const resource = await new ActorResourceRegistry().publish({ id: input.resource_id, owner: self, capacity: input.capacity, metadata: input.metadata })
      return {
        data: {
          success: true, self, resource,
          message: `Offered ${resource.id}: ${resource.available}/${resource.capacity} units available (owner ${resource.owner})`,
        },
      }
    }
    if (input.action === 'resource_list') {
      if ($?.actor) {
        const listed = await $.actor.resource_list({})
        return {
          data: {
            success: true, self, resources: listed,
            message: formatResourceList(listed),
          },
        }
      }
      const listed = await new ActorResourceRegistry().list()
      return {
        data: {
          success: true, self, resources: listed,
          message: formatResourceList(listed),
        },
      }
    }
    if (input.action === 'resource_acquire') {
      if ($?.actor) {
        const acquired = await $.actor.resource_acquire({ address: self, resourceId: input.resource_id, units: input.units, ttlMs: input.ttl_ms, note: input.note })
        if (acquired.resource.owner !== self) {
          await $.actor.tx({
            address: self, to: acquired.resource.owner,
            payload: { event: 'resource_acquired', resource: acquired.resource.id, lease: acquired.lease },
            kind: 'resource.acquired', correlationId: acquired.lease.id, ttlMs: input.ttl_ms,
          })
        }
        return {
          data: {
            success: true, self, resource: acquired.resource, lease: acquired.lease,
            message: `Acquired ${acquired.lease.units} unit(s) of ${acquired.resource.id}; lease ${acquired.lease.id} expires ${acquired.lease.expiresAt}`,
          },
        }
      }
      const runtime = createCurrentActorRuntime()
      const acquired = await new ActorResourceRegistry().acquire({ resourceId: input.resource_id, holder: self, units: input.units, ttlMs: input.ttl_ms, note: input.note })
      if (acquired.resource.owner !== self) {
        await runtime.tx(acquired.resource.owner,
          { event: 'resource_acquired', resource: acquired.resource.id, lease: acquired.lease },
          { kind: 'resource.acquired', correlationId: acquired.lease.id, ttlMs: input.ttl_ms })
      }
      return {
        data: {
          success: true, self, resource: acquired.resource, lease: acquired.lease,
          message: `Acquired ${acquired.lease.units} unit(s) of ${acquired.resource.id}; lease ${acquired.lease.id} expires ${acquired.lease.expiresAt}`,
        },
      }
    }
    if (input.action === 'resource_release') {
      if ($?.actor) {
        const released = await $.actor.resource_release({ address: self, leaseId: input.lease_id })
        const releasePeer = released.resource.owner === self ? released.lease.holder : released.resource.owner
        if (releasePeer !== self) {
          await $.actor.tx({ address: self, to: releasePeer,
            payload: { event: 'resource_released', resource: released.resource.id, lease: released.lease },
            kind: 'resource.released', correlationId: released.lease.id })
        }
        return {
          data: { success: true, self, lease: released.lease, message: `Released lease ${released.lease.id} for ${released.resource.id}` },
        }
      }
      const runtime = createCurrentActorRuntime()
      const released = await new ActorResourceRegistry().release({ leaseId: input.lease_id, actor: self })
      const releasePeer = released.resource.owner === self ? released.lease.holder : released.resource.owner
      if (releasePeer !== self) {
        await runtime.tx(releasePeer,
          { event: 'resource_released', resource: released.resource.id, lease: released.lease },
          { kind: 'resource.released', correlationId: released.lease.id })
      }
      return {
        data: { success: true, self, lease: released.lease, message: `Released lease ${released.lease.id} for ${released.resource.id}` },
      }
    }
    if (input.action === 'rx') {
      if ($?.actor) {
        const envelopes = await $.actor.rx({ address: self, timeoutMs: input.timeout_ms, limit: input.limit, signal: context?.abortController?.signal })
        return {
          data: {
            success: true, self, envelopes,
            message: formatEnvelopes(envelopes),
          },
        }
      }
      const envelopes = await createCurrentActorRuntime().rx({ timeoutMs: input.timeout_ms, limit: input.limit, signal: context?.abortController?.signal })
      return {
        data: {
          success: true, self, envelopes,
          message: formatEnvelopes(envelopes),
        },
      }
    }

    // ── tx (default action) ──
    let envelope
    if ($?.actor) {
      envelope = await $.actor.tx({ address: self, to: input.to, payload: input.payload ?? null, kind: input.kind, correlationId: input.correlation_id, ttlMs: input.ttl_ms })
    } else {
      envelope = await createCurrentActorRuntime().tx(input.to, input.payload ?? null, { kind: input.kind, correlationId: input.correlation_id, ttlMs: input.ttl_ms })
    }

    // Compatibility adapter: existing OpenCC agents still poll the teammate
    // mailbox while actor-native agents consume the durable envelope mailbox.
    const destination = parseActorAddress(input.to, getTeamName() || 'default')
    if (destination.transport === 'local') {
      await writeToMailbox(
        destination.name,
        {
          from: getAgentName() || self,
          text: typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload ?? null),
          timestamp: new Date().toISOString(),
          color: getTeammateColor(),
        },
        destination.team,
      )
    }
    return {
      data: {
        success: true, self, envelope,
        message: `Sent ${envelope.from} -> ${envelope.to} [${envelope.kind}${envelope.correlationId ? ` #${envelope.correlationId}` : ''}] ${preview(envelope.payload)}`,
      },
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
