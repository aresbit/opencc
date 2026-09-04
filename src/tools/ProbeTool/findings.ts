import { join } from 'path'
import { ensureStateDir, fileExists, probeStateDir } from './runtime.js'

export interface CodeLocation {
  file: string
  start_line: number
  end_line: number
  fix_before?: string
  fix_after?: string
}

export interface Finding {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  confidence: 'high' | 'medium' | 'low'
  status: 'candidate' | 'verified' | 'ruled_out' | 'needs_follow_up'
  target: string
  cwe?: string
  evidence?: string
  poc?: string
  counterevidence?: string
  remediation?: string
  code_locations?: CodeLocation[]
  createdAt: string
  updatedAt: string
}

export type FindingInput = Omit<Finding, 'id' | 'status' | 'createdAt' | 'updatedAt'>

function findingsPath(): string {
  return join(probeStateDir(), 'findings.json')
}

export async function readFindings(): Promise<Finding[]> {
  await ensureStateDir()
  if (!(await fileExists(findingsPath()))) return []
  try {
    const raw = await Bun.file(findingsPath()).text()
    const parsed = JSON.parse(raw) as { findings?: Finding[] }
    return Array.isArray(parsed.findings) ? parsed.findings : []
  } catch {
    return []
  }
}

export async function writeFindings(findings: Finding[]): Promise<void> {
  await ensureStateDir()
  await Bun.write(findingsPath(), JSON.stringify({ findings }, null, 2))
}

export async function nextFindingId(): Promise<string> {
  const findings = await readFindings()
  const max = findings.reduce((m, f) => {
    const n = parseInt(f.id.replace(/\D/g, ''), 10)
    return Number.isFinite(n) && n > m ? n : m
  }, 0)
  return `prob-${String(max + 1).padStart(4, '0')}`
}

export function formatFindingsMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings recorded.'
  const lines: string[] = []
  for (const f of findings) {
    lines.push(
      `## ${f.id} ${f.title}`,
      `- severity: ${f.severity}`,
      `- confidence: ${f.confidence}`,
      `- status: ${f.status}`,
      `- target: ${f.target}`,
      f.cwe ? `- cwe: ${f.cwe}` : '',
      f.evidence ? `\n### Evidence\n${f.evidence}` : '',
      f.poc ? `\n### PoC\n\`\`\`\n${f.poc}\n\`\`\`` : '',
      f.counterevidence ? `\n### Counter-evidence\n${f.counterevidence}` : '',
      f.remediation ? `\n### Remediation\n${f.remediation}` : '',
      '',
    )
  }
  return lines.filter(Boolean).join('\n')
}
