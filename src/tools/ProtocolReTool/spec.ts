import type { Cluster, Fsm, FsmTransition } from './algorithms.js'

export interface Field {
  offset: number
  width: number
  kind: 'const' | 'var' | 'length' | 'checksum' | 'enum' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  note?: string
}

export interface MessageType {
  id: number
  size: number
  count: number
  sampleHex: string
}

export interface ProtocolSpec {
  id: string
  input: string
  fields: Field[]
  messageTypes: MessageType[]
  fsm: { states: Fsm['states']; transitions: FsmTransition[] }
  exportedAt?: string
}

export function specToMarkdown(spec: ProtocolSpec): string {
  const lines = [`# Protocol Spec: ${spec.id}`, '', `input: ${spec.input}`, '']
  lines.push('## Fields', '')
  if (spec.fields.length === 0) {
    lines.push('(no fields inferred yet)', '')
  } else {
    lines.push('| offset | width | kind | confidence | note |', '|---|---|---|---|---|')
    for (const f of spec.fields) {
      lines.push(`| ${f.offset} | ${f.width} | ${f.kind} | ${f.confidence} | ${f.note ?? ''} |`)
    }
    lines.push('')
  }
  lines.push('## Message types', '')
  if (spec.messageTypes.length === 0) {
    lines.push('(none)', '')
  } else {
    for (const mt of spec.messageTypes) {
      lines.push(`- type ${mt.id}: size ${mt.size} bytes, ${mt.count} messages, sample \`${mt.sampleHex}\``)
    }
    lines.push('')
  }
  lines.push('## State machine', '')
  if (spec.fsm.transitions.length === 0) {
    lines.push('(no transitions inferred)', '')
  } else {
    for (const t of spec.fsm.transitions) {
      lines.push(`- ${t.from} -> ${t.to}: ${t.count}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function specToJson(spec: ProtocolSpec): string {
  return JSON.stringify(spec, null, 2)
}
