import { z } from 'zod/v4'
import { getCurrentActorAddress } from '../../actor/currentActor.js'
import { LocalActorMailbox } from '../../actor/LocalActorMailbox.js'
import { parseActorAddress } from '../../actor/types.js'
import {
  describeState,
  observeEpisode,
  planRoutes,
  pumpOnce,
  sendRouted,
} from '../../swarm/relay.js'
import { learnPolicy, topEdges } from '../../swarm/policy.js'
import {
  announceLocalRecord,
  listDnsRecords,
  routableAddress,
  type AgentStatus,
} from '../../swarm/dns.js'
import { getSwarmTeam, loadState, withState } from '../../swarm/store.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SWARM_NET_TOOL_NAME } from './constants.js'
import { DESCRIPTION } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('status') }),
    z.strictObject({
      action: z.literal('plan'),
      dst: z.string().min(1).describe('Destination actor address'),
      src: z
        .string()
        .min(1)
        .optional()
        .describe('Source actor address; defaults to this session'),
      max_hops: z.number().int().min(1).max(6).optional(),
      top_k: z.number().int().min(1).max(10).optional(),
    }),
    z.strictObject({
      action: z.literal('observe'),
      dst: z.string().min(1),
      src: z.string().min(1).optional(),
      path: z
        .array(z.string().min(1))
        .min(2)
        .optional()
        .describe('Observed hop chain including endpoints. Omit to decode by Viterbi.'),
      success: z.boolean(),
      latency_ms: z.number().nonnegative(),
      reward: z.number().min(0).max(1).optional(),
      observed: z.boolean().optional(),
      max_hops: z.number().int().min(1).max(6).optional(),
    }),
    z.strictObject({
      action: z.literal('send'),
      to: z.string().min(1).describe('Final destination actor address'),
      payload: z.unknown().optional(),
      kind: z.string().optional(),
      correlation_id: z.string().optional(),
      ttl_ms: z.number().int().positive().max(3_600_000).optional(),
      max_hops: z.number().int().min(1).max(6).optional(),
      expect_ack_ms: z.number().int().min(0).max(30_000).optional(),
      force_direct: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal('pump'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    z.strictObject({ action: z.literal('learn') }),
    z.strictObject({
      action: z.literal('announce'),
      address: z
        .string()
        .min(1)
        .optional()
        .describe('Actor address to announce; defaults to this session'),
      capabilities: z.array(z.string().min(1)).max(32).optional(),
      roles: z.array(z.string().min(1)).max(16).optional(),
      load: z.number().nonnegative().optional(),
      status: z.enum(['idle', 'busy', 'offline']).optional(),
    }),
    z.strictObject({
      action: z.literal('discover'),
      team: z.string().optional(),
      capability: z.string().optional(),
      role: z.string().optional(),
      live_only: z.boolean().optional(),
    }),
  ]),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const SwarmNetTool = buildTool({
  name: SWARM_NET_TOOL_NAME,
  searchHint: 'learned multi-hop actor routing, pheromone, Viterbi path decoding',
  userFacingName: () => 'SwarmNet',
  maxResultSizeChars: 120_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isReadOnly(input) {
    return input?.action === 'status' || input?.action === 'plan'
  },
  isConcurrencySafe() {
    return false
  },
  isDestructive() {
    return false
  },
  toAutoClassifierInput(input) {
    switch (input.action) {
      case 'send':
        return `send ${input.to}`
      case 'observe':
        return `observe ${input.dst}`
      case 'plan':
        return `plan ${input.dst}`
      default:
        return input.action
    }
  },
  async description() {
    return 'Learned multi-hop routing between actor sessions'
  },
  async prompt() {
    return DESCRIPTION
  },
  async call(input) {
    const team = getSwarmTeam()
    const self = getCurrentActorAddress()

    switch (input.action) {
      case 'status': {
        const state = await loadState(team)
        const edges = topEdges(state, 10)
        return {
          data: {
            action: 'status',
            message: `${describeState(state)}\nself=${self}`,
            data: {
              self,
              policy: state.policy,
              edges,
              episodes: state.episodes.length,
              bestMetric: state.bestMetric,
            },
          },
        }
      }
      case 'plan': {
        const state = await loadState(team)
        const routes = await planRoutes(state, {
          src: input.src ?? self,
          dst: input.dst,
          maxHops: input.max_hops,
          topK: input.top_k,
        })
        const message =
          routes.length > 0
            ? routes
                .map(
                  (route, index) =>
                    `${index + 1}. ${route.path.join(' -> ')} (score ${route.score.toFixed(2)})`,
                )
                .join('\n')
            : `No route from ${input.src ?? self} to ${input.dst} within ${input.max_hops ?? 3} hops.`
        return {
          data: {
            action: 'plan',
            message: `${message}\npolicy=v${state.policy.version} self=${self}`,
            data: { routes, policyVersion: state.policy.version },
          },
        }
      }
      case 'observe': {
        const result = await observeEpisode({
          src: input.src,
          dst: input.dst,
          path: input.path,
          success: input.success,
          latencyMs: input.latency_ms,
          reward: input.reward,
          observed: input.observed,
          maxHops: input.max_hops,
        })
        return {
          data: {
            action: 'observe',
            message:
              `${result.inferred ? 'Decoded' : 'Recorded'} ${result.path.join(' -> ')} ` +
              `confidence=${result.confidence.toFixed(2)} success=${input.success}`,
            data: result,
          },
        }
      }
      case 'send': {
        const result = await sendRouted({
          to: input.to,
          payload: input.payload,
          kind: input.kind,
          correlationId: input.correlation_id,
          ttlMs: input.ttl_ms,
          maxHops: input.max_hops,
          expectAckMs: input.expect_ack_ms,
          forceDirect: input.force_direct,
        })
        return {
          data: {
            action: 'send',
            message:
              `${result.mode} ${result.path.join(' -> ')} id=${result.envelopeId}` +
              (result.ack ? ` ack=${result.ack}` : ''),
            data: result,
          },
        }
      }
      case 'pump': {
        const result = await pumpOnce(input.limit)
        return {
          data: {
            action: 'pump',
            message:
              `self=${result.self} forwarded=${result.forwarded} ` +
              `delivered=${result.delivered} dead=${result.dead}`,
            data: result,
          },
        }
      }
      case 'learn': {
        const result = await withState(team, state => {
          const learned = learnPolicy(state)
          return { learned, policy: state.policy, bestMetric: state.bestMetric }
        })
        return {
          data: {
            action: 'learn',
            message:
              `policy=v${result.policy.version} adopted=${result.learned.adopted} ` +
              `incumbent=${result.learned.incumbentAccuracy.toFixed(3)} ` +
              `candidate=${result.learned.candidateAccuracy.toFixed(3)} ` +
              `pairs=${result.learned.pairs} episodes=${result.learned.episodes}`,
            data: result,
          },
        }
      }
      case 'announce': {
        const address = input.address ?? self
        const parsed = parseActorAddress(address, getSwarmTeam())
        const record = await announceLocalRecord({
          address: parsed.canonical,
          team: parsed.team,
          name: parsed.name,
          capabilities: input.capabilities,
          roles: input.roles,
          load: input.load,
          status: input.status as AgentStatus | undefined,
        })
        return {
          data: {
            action: 'announce',
            message:
              `announced ${record.address} caps=[${record.capabilities.join(',')}] ` +
              `roles=[${record.roles.join(',')}] status=${record.status}`,
            data: record,
          },
        }
      }
      case 'discover': {
        const dnsRecords = await listDnsRecords({
          team: input.team ?? team,
          capability: input.capability,
          role: input.role,
          liveOnly: input.live_only ?? true,
        })
        // actord already knows peers across IP after its WebSocket handshake.
        // Merge those live addresses so `discover` does not pretend a WAN peer
        // does not exist just because it never sent a LAN multicast beacon.
        const mailbox = new LocalActorMailbox()
        const mailboxPeers = (await mailbox.list()).filter(
          peer => peer.live !== false && peer.address !== self,
        )
        const merged = new Map<
          string,
          {
            address: string
            node?: string
            capabilities: string[]
            roles: string[]
            load: number
            status: string
            source: 'dns' | 'actord'
          }
        >()
        for (const record of dnsRecords) {
          merged.set(routableAddress(record), {
            address: routableAddress(record),
            node: record.node,
            capabilities: record.capabilities,
            roles: record.roles,
            load: record.load,
            status: record.status,
            source: 'dns',
          })
        }
        for (const peer of mailboxPeers) {
          if (merged.has(peer.address)) continue
          if (input.team || input.capability || input.role) continue
          let parsed
          try {
            parsed = parseActorAddress(peer.address)
          } catch {
            continue
          }
          merged.set(peer.address, {
            address: peer.address,
            node: parsed.node,
            capabilities: [],
            roles: [],
            load: 0,
            status: peer.live ? 'idle' : 'offline',
            source: 'actord',
          })
        }
        const entries = [...merged.values()]
        return {
          data: {
            action: 'discover',
            message:
              entries.length === 0
                ? 'No live peers. Run `opencc actord` for cross-IP, or `opencc swarm-daemon` for LAN discovery.'
                : entries
                    .map(
                      record =>
                        `${record.address} source=${record.source}` +
                        (record.node ? ` node=${record.node}` : '') +
                        ` caps=[${record.capabilities.join(',')}]` +
                        ` roles=[${record.roles.join(',')}]` +
                        ` load=${record.load} status=${record.status}`,
                    )
                    .join('\n'),
            data: entries,
          },
        }
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
