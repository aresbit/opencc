/**
 * UDP multicast/broadcast transport for Agent-DNS.
 *
 * One socket per host: joins the group, sends beacons, answers queries with a
 * unicast beacon, and forwards validated packets to the daemon. The transport
 * does not decide what a packet means; that keeps the security check in one
 * place (verifyBeacon) and the merge logic testable without a network.
 *
 * Two delivery paths are attempted for every beacon: multicast on the selected
 * LAN interface, and limited/subnet broadcast. Home routers and Wi-Fi APs often
 * filter one but not the other; sending both turns a silent "no peers" into a
 * diagnosis the join script can print.
 */

import { createSocket, type RemoteInfo, type Socket } from 'dgram'
import {
  buildBeacon,
  encodeBeacon,
  parseBeacon,
  parseBootstrapTarget,
  verifyBeacon,
  type AgentDnsBeacon,
  type AgentDnsBeaconKind,
  type AgentDnsRecord,
  type DnsConfig,
} from './dns.js'
import { broadcastTargets, pickSwarmInterface } from './network.js'

export type DnsPacket = {
  beacon: AgentDnsBeacon
  from: RemoteInfo
  at: number
}

export type DnsTransportStats = {
  sent: number
  received: number
  dropped: number
  sendErrors: number
  interface?: string
  broadcast: boolean
}

export type DnsTransport = {
  announce: (
    kind: AgentDnsBeaconKind,
    records: readonly AgentDnsRecord[],
    target?: { address: string; port: number },
  ) => Promise<void>
  close: () => Promise<void>
  stats: () => DnsTransportStats
}

export async function openDnsTransport(
  config: DnsConfig,
  onPacket: (packet: DnsPacket) => void,
  log: (line: string) => void,
  options: { unref?: boolean } = {},
): Promise<DnsTransport> {
  const stats: DnsTransportStats = {
    sent: 0,
    received: 0,
    dropped: 0,
    sendErrors: 0,
    broadcast: config.broadcast,
  }
  if (config.disabled) {
    return {
      announce: async () => {},
      close: async () => {},
      stats: () => stats,
    }
  }

  const picked = pickSwarmInterface(config.interface)
  if (!picked) {
    log(
      `dns: no non-internal IPv4 interface found${
        config.interface ? ` (requested ${config.interface})` : ''
      }; multicast will use the OS default`,
    )
  } else {
    stats.interface = `${picked.name} ${picked.address}`
    log(`dns: interface ${picked.name} ${picked.address} (${picked.broadcast})`)
  }

  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true })
  let closed = false

  socket.on('error', error => {
    stats.sendErrors++
    log(`dns socket error: ${error.message}`)
  })

  socket.on('message', (raw, from) => {
    const beacon = parseBeacon(raw)
    if (!beacon) {
      stats.dropped++
      return
    }
    const verdict = verifyBeacon(beacon, config.token)
    if (!verdict.ok) {
      stats.dropped++
      log(`dns drop ${beacon.kind} from ${beacon.node}: ${verdict.reason}`)
      return
    }
    stats.received++
    onPacket({ beacon, from, at: Date.now() })
  })

  await new Promise<void>((resolve, reject) => {
    const onBindError = (error: Error) => {
      socket.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      socket.removeListener('error', onBindError)
      socket.setMulticastTTL(1)
      socket.setMulticastLoopback(true)
      if (config.broadcast) {
        try {
          socket.setBroadcast(true)
        } catch (error) {
          log(
            `dns: setBroadcast failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
      if (picked) {
        const multicast = socket as unknown as {
          setMulticastInterface?: (address: string) => void
        }
        try {
          multicast.setMulticastInterface?.(picked.address)
        } catch (error) {
          log(
            `dns: setMulticastInterface failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
      try {
        if (picked) socket.addMembership(config.group, picked.address)
        else socket.addMembership(config.group)
      } catch (error) {
        log(
          `dns multicast join failed for ${config.group}${
            picked ? ` on ${picked.address}` : ''
          }: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      resolve()
    }
    socket.once('error', onBindError)
    socket.once('listening', onListening)
    socket.bind(config.port)
  })

  // Embedded in a one-shot session (opencc --matebot -p ...), the daemon must
  // not keep the process alive. A standalone daemon owns the event loop, so it
  // leaves the socket referenced.
  if (options.unref !== false) {
    ;(socket as unknown as { unref?: () => void }).unref?.()
  }

  const send = (packet: Buffer, address: string, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      socket.send(packet, port, address, error => {
        if (error) reject(error)
        else resolve()
      })
    })

  return {
    async announce(kind, records, target) {
      if (closed) return
      const beacon = buildBeacon(kind, records, config)
      const packet = encodeBeacon(beacon)
      const destinations = target
        ? [target]
        : [
            { address: config.group, port: config.port },
            ...(config.broadcast
              ? broadcastTargets().map(address => ({
                  address,
                  port: config.port,
                }))
              : []),
            // Unicast bootstrap crosses subnets where multicast is filtered.
            // It needs one reachable host per island, not a flat L2 domain.
            ...config.bootstrap
              .map(item => parseBootstrapTarget(item, config.port))
              .filter(
                (item): item is { host: string; port: number } => item !== null,
              )
              .map(item => ({ address: item.host, port: item.port })),
          ]
      for (const destination of destinations) {
        try {
          await send(packet, destination.address, destination.port)
          stats.sent++
        } catch (error) {
          stats.sendErrors++
          log(
            `dns send ${kind} to ${destination.address} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    },
    async close() {
      if (closed) return
      closed = true
      try {
        socket.dropMembership(config.group)
      } catch {
        // Never joined.
      }
      await new Promise<void>(resolve => socket.close(() => resolve()))
    },
    stats: () => stats,
  }
}
