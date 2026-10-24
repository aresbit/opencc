/**
 * UDP multicast transport for Agent-DNS.
 *
 * One socket per host: joins the group, sends beacons, answers queries with a
 * unicast beacon, and forwards validated packets to the daemon. The transport
 * does not decide what a packet means; that keeps the security check in one
 * place (verifyBeacon) and the merge logic testable without a network.
 */

import { createSocket, type RemoteInfo, type Socket } from 'dgram'
import {
  buildBeacon,
  encodeBeacon,
  parseBeacon,
  verifyBeacon,
  type AgentDnsBeacon,
  type AgentDnsBeaconKind,
  type AgentDnsRecord,
  type DnsConfig,
} from './dns.js'

export type DnsPacket = {
  beacon: AgentDnsBeacon
  from: RemoteInfo
  at: number
}

export type DnsTransport = {
  announce: (
    kind: AgentDnsBeaconKind,
    records: readonly AgentDnsRecord[],
    target?: { address: string; port: number },
  ) => Promise<void>
  close: () => Promise<void>
}

export async function openDnsTransport(
  config: DnsConfig,
  onPacket: (packet: DnsPacket) => void,
  log: (line: string) => void,
  options: { unref?: boolean } = {},
): Promise<DnsTransport> {
  if (config.disabled) {
    return {
      announce: async () => {},
      close: async () => {},
    }
  }

  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true })
  let closed = false

  socket.on('error', error => {
    log(`dns socket error: ${error.message}`)
  })

  socket.on('message', (raw, from) => {
    const beacon = parseBeacon(raw)
    if (!beacon) return
    const verdict = verifyBeacon(beacon, config.token)
    if (!verdict.ok) {
      log(`dns drop ${beacon.kind} from ${beacon.node}: ${verdict.reason}`)
      return
    }
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
      try {
        socket.addMembership(config.group)
      } catch (error) {
        // Some CI/container networks have no multicast route. Unicast queries
        // and replies still work; discovery degrades to configured peers.
        log(
          `dns multicast join failed for ${config.group}: ${
            error instanceof Error ? error.message : String(error)
          }`,
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

  return {
    async announce(kind, records, target) {
      if (closed) return
      const beacon = buildBeacon(kind, records, config)
      const packet = encodeBeacon(beacon)
      const send = (address: string, port: number) =>
        new Promise<void>((resolve, reject) => {
          socket.send(packet, port, address, error => {
            if (error) reject(error)
            else resolve()
          })
        })
      try {
        if (target) {
          await send(target.address, target.port)
        } else {
          await send(config.group, config.port)
        }
      } catch (error) {
        log(
          `dns send ${kind} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
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
  }
}
