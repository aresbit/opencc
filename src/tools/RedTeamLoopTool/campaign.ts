import { join } from 'path'
import { ensureStateDir, fileExists, probeStateDir } from '../ProbeTool/runtime.js'

/** One iteration of the loop. `produced` is the attribution core: the finding
 *  ids THIS step produced — not the ids that happen to exist after it ran. */
export interface LoopStep {
  n: number
  intent: string
  method: string
  command?: string
  observation: string
  produced: string[]
  at: string
}

/** The negative control. A trivial baseline that does not use the loop's
 *  reasoning, run so we can subtract what it reaches from what the loop reaches. */
export interface NegativeControl {
  method: string
  command?: string
  reached: string
  at: string
}

export interface Campaign {
  id: string
  target: string
  objective: string
  budgetSteps: number
  steps: LoopStep[]
  baseline?: NegativeControl
  status: 'open' | 'closed' | 'halted'
  haltReason?: string
  createdAt: string
  closedAt?: string
}

function campaignsPath(): string {
  return join(probeStateDir(), 'redteam-campaigns.json')
}

export async function readCampaigns(): Promise<Campaign[]> {
  await ensureStateDir()
  if (!(await fileExists(campaignsPath()))) return []
  try {
    const raw = await Bun.file(campaignsPath()).text()
    const parsed = JSON.parse(raw) as { campaigns?: Campaign[] }
    return Array.isArray(parsed.campaigns) ? parsed.campaigns : []
  } catch {
    return []
  }
}

export async function writeCampaigns(campaigns: Campaign[]): Promise<void> {
  await ensureStateDir()
  await Bun.write(campaignsPath(), JSON.stringify({ campaigns }, null, 2))
}

export async function openCampaign(): Promise<Campaign | undefined> {
  const campaigns = await readCampaigns()
  return campaigns.find(c => c.status === 'open')
}

export async function nextCampaignId(): Promise<string> {
  const campaigns = await readCampaigns()
  const max = campaigns.reduce((m, c) => {
    const n = parseInt(c.id.replace(/\D/g, ''), 10)
    return Number.isFinite(n) && n > m ? n : m
  }, 0)
  return `rt-${String(max + 1).padStart(4, '0')}`
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
  const campaigns = await readCampaigns()
  const idx = campaigns.findIndex(c => c.id === campaign.id)
  if (idx >= 0) campaigns[idx] = campaign
  else campaigns.push(campaign)
  await writeCampaigns(campaigns)
}

export interface Attribution {
  totalFindings: number
  findingsByStep: { step: number; intent: string; produced: string[] }[]
  emptySteps: number
  baselineReached: string | null
  baselineOverlap: string[]
  netAttributable: number
  firstSeenStep: Record<string, number>
  stepsUsed: number
  budgetSteps: number
  verdict: string
}

/**
 * The measurement this tool exists for. Everything is derived from what the
 * steps actually recorded — no credit is inferred from ordering or proximity.
 */
export function computeAttribution(campaign: Campaign): Attribution {
  const firstSeenStep: Record<string, number> = {}
  const findingsByStep: Attribution['findingsByStep'] = []
  let emptySteps = 0

  for (const s of campaign.steps) {
    findingsByStep.push({ step: s.n, intent: s.intent, produced: [...s.produced] })
    if (s.produced.length === 0) emptySteps += 1
    for (const id of s.produced) {
      if (!(id in firstSeenStep)) firstSeenStep[id] = s.n
    }
  }

  const totalFindings = Object.keys(firstSeenStep).length

  // A finding is only attributable to the loop if the trivial baseline did not
  // already reach it. The baseline records ids it reached, same id space.
  const baselineReached = campaign.baseline?.reached ?? null
  const overlapText = campaign.baseline?.reached ?? ''
  const baselineOverlap = Object.keys(firstSeenStep).filter(id =>
    new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(overlapText),
  )
  const netAttributable = totalFindings - baselineOverlap.length

  const parts: string[] = []
  parts.push(`${totalFindings} finding(s) across ${campaign.steps.length} step(s)`)
  parts.push(`${emptySteps} step(s) produced nothing`)
  if (baselineReached === null) {
    parts.push('NO BASELINE RUN — net attributable is not yet meaningful (run action "baseline")')
  } else {
    parts.push(`${baselineOverlap.length} also reached by the trivial baseline`)
    parts.push(`net attributable to the loop = ${netAttributable}`)
  }
  if (netAttributable <= 0 && baselineReached !== null && totalFindings > 0) {
    parts.push('VERDICT: no gain over the trivial baseline — report this as a negative result')
  }

  return {
    totalFindings,
    findingsByStep,
    emptySteps,
    baselineReached,
    baselineOverlap,
    netAttributable,
    firstSeenStep,
    stepsUsed: campaign.steps.length,
    budgetSteps: campaign.budgetSteps,
    verdict: parts.join('; '),
  }
}

export function formatCampaignMarkdown(campaign: Campaign): string {
  const a = computeAttribution(campaign)
  const lines: string[] = [
    `## Campaign ${campaign.id} — ${campaign.status}`,
    `- target: ${campaign.target}`,
    `- objective: ${campaign.objective}`,
    `- budget: ${a.stepsUsed}/${a.budgetSteps} steps`,
    campaign.haltReason ? `- halt reason: ${campaign.haltReason}` : '',
    '',
    '### Verdict',
    a.verdict,
    '',
    '### Steps',
  ]
  for (const s of campaign.steps) {
    lines.push(
      `${s.n}. **${s.intent}** — method: ${s.method}`,
      s.command ? `   - cmd: \`${s.command}\`` : '',
      `   - observation: ${s.observation}`,
      `   - produced: ${s.produced.length ? s.produced.join(', ') : '(nothing)'}`,
    )
  }
  if (campaign.baseline) {
    lines.push(
      '',
      '### Negative control',
      `- method: ${campaign.baseline.method}`,
      campaign.baseline.command ? `- cmd: \`${campaign.baseline.command}\`` : '',
      `- reached: ${campaign.baseline.reached}`,
    )
  }
  return lines.filter(Boolean).join('\n')
}
