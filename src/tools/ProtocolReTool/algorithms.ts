// Deterministic PRE primitives: byte helpers, entropy, positional column stats,
// length clustering, and coarse FSM inference. Gap-aware Needleman-Wunsch is a
// P1 refinement for variable-length protocols; the MVP uses positional stats.

export function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const out: number[] = []
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16))
  }
  return out
}

export function bytesToHex(bytes: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]
    out += v < 0 ? '--' : v.toString(16).padStart(2, '0')
  }
  return out
}

/** Shannon entropy (bits) of a column, ignoring gap placeholders (-1). */
export function byteEntropy(values: number[]): number {
  const counts = new Map<number, number>()
  let total = 0
  for (const v of values) {
    if (v < 0) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
    total++
  }
  if (total === 0) return 0
  let h = 0
  for (const c of counts.values()) {
    const p = c / total
    h -= p * Math.log2(p)
  }
  return h
}

export interface ColumnStat {
  offset: number
  constantRate: number
  entropy: number
  dominantByte: number
}

/**
 * Positional column stats over left-aligned byte rows: how often each byte
 * offset is constant, its entropy, and the dominant byte. The primary signal
 * for field boundaries in fixed-length protocols (and the common prefix of
 * variable-length ones).
 */
export function columnStats(rows: number[][]): ColumnStat[] {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const stats: ColumnStat[] = []
  for (let c = 0; c < width; c++) {
    const counts = new Map<number, number>()
    let total = 0
    const values: number[] = []
    for (const r of rows) {
      const v = c < r.length ? r[c] : -1
      values.push(v)
      if (v < 0) continue
      counts.set(v, (counts.get(v) ?? 0) + 1)
      total++
    }
    let dominant = -1
    let dominantCount = 0
    for (const [k, cnt] of counts) {
      if (cnt > dominantCount) {
        dominant = k
        dominantCount = cnt
      }
    }
    stats.push({
      offset: c,
      constantRate: total > 0 ? dominantCount / total : 0,
      entropy: byteEntropy(values),
      dominantByte: dominant,
    })
  }
  return stats
}

export interface Cluster {
  id: number
  size: number
  count: number
  members: number[]
  sampleHex: string
}

/** Cluster messages by byte length — the cheapest message-type proxy. */
export function clusterBySize(messages: number[][]): Cluster[] {
  const bySize = new Map<number, number[]>()
  messages.forEach((m, i) => {
    const key = m.length
    const list = bySize.get(key) ?? []
    list.push(i)
    bySize.set(key, list)
  })
  const clusters: Cluster[] = []
  let id = 0
  for (const [size, members] of [...bySize.entries()].sort((a, b) => a[0] - b[0])) {
    clusters.push({
      id,
      size,
      count: members.length,
      members,
      sampleHex: bytesToHex(messages[members[0]]),
    })
    id++
  }
  return clusters
}

export interface FsmTransition {
  from: number
  to: number
  count: number
}

export interface Fsm {
  states: Array<{ id: number; cluster: number; count: number }>
  transitions: FsmTransition[]
}

/**
 * Coarse FSM: count type→type transitions in capture order, keep edges with
 * count >= minSupport. `labels[i]` is the cluster/type id of message i.
 */
export function inferFsm(labels: number[], minSupport: number): Fsm {
  const stateCounts = new Map<number, number>()
  const edgeCounts = new Map<string, number>()
  for (const l of labels) stateCounts.set(l, (stateCounts.get(l) ?? 0) + 1)
  for (let i = 0; i + 1 < labels.length; i++) {
    const key = `${labels[i]}>${labels[i + 1]}`
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
  }
  const states = [...stateCounts.entries()].map(([id, count]) => ({ id, cluster: id, count }))
  const transitions: FsmTransition[] = []
  for (const [key, count] of edgeCounts) {
    if (count < minSupport) continue
    const [from, to] = key.split('>').map(Number)
    transitions.push({ from, to, count })
  }
  return { states, transitions: transitions.sort((a, b) => b.count - a.count) }
}
