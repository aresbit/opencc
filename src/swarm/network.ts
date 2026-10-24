/**
 * IPv4 interface selection for LAN discovery.
 *
 * Multicast on a laptop with Docker, VPN and Tailscale interfaces often leaves
 * through the wrong NIC: the packet is sent, the socket reports success, and no
 * peer ever sees it. Picking the private LAN address explicitly — and also
 * sending a limited broadcast — turns that silent failure into a working
 * default on most home/office networks.
 */

import { networkInterfaces } from 'os'

export type SwarmInterface = {
  name: string
  address: string
  netmask: string
  broadcast: string
}

const VIRTUAL_PREFIXES = [
  'docker',
  'br-',
  'veth',
  'virbr',
  'vmnet',
  'vboxnet',
  'tailscale',
  'utun',
  'tun',
  'tap',
  'zt',
  'wg',
  'cni',
  'flannel',
  'lo',
]

const PREFERRED_PREFIXES = ['en', 'eth', 'wlan', 'wl', 'wlp', 'eno', 'ens', 'enp']

function ipv4ToInt(address: string): number {
  return address
    .split('.')
    .reduce((sum, part) => ((sum << 8) + Number.parseInt(part, 10)) >>> 0, 0)
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.')
}

function broadcastFor(address: string, netmask: string): string {
  const ip = ipv4ToInt(address)
  const mask = ipv4ToInt(netmask)
  return intToIpv4(((ip & mask) | (~mask >>> 0)) >>> 0)
}

function isPrivate(address: string): boolean {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  )
}

export function listSwarmInterfaces(): SwarmInterface[] {
  const found: SwarmInterface[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        broadcast: broadcastFor(entry.address, entry.netmask),
      })
    }
  }
  return found
}

/**
 * `preferred` may be an interface name or an IPv4 address. Without one, prefer
 * a real-looking physical NIC on a private range and skip container/VPN links.
 */
export function pickSwarmInterface(
  preferred?: string,
): SwarmInterface | null {
  const all = listSwarmInterfaces()
  if (all.length === 0) return null
  if (preferred?.trim()) {
    const value = preferred.trim()
    return all.find(item => item.name === value || item.address === value) ?? null
  }

  const score = (item: SwarmInterface): number => {
    let points = 0
    if (isPrivate(item.address)) points += 10
    if (PREFERRED_PREFIXES.some(prefix => item.name.startsWith(prefix))) points += 5
    if (VIRTUAL_PREFIXES.some(prefix => item.name.startsWith(prefix))) points -= 20
    return points
  }

  return [...all].sort((a, b) => score(b) - score(a))[0] ?? null
}

export function broadcastTargets(): string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const item of listSwarmInterfaces()) {
    targets.add(item.broadcast)
  }
  return [...targets]
}
