/**
 * Red Team Mode - 白帽比赛专用功能
 * 通过环境变量 RED_TEAM_MODE=1 激活
 *
 * v2.0 集成 rtm-harness 安全测试能力:
 * - 威胁建模 (threat-model)
 * - 静态漏洞扫描 (vuln-scan)
 * - 分类验证 (triage)
 * - 补丁生成 (patch)
 * - 攻击面侦察 (recon)
 * - 可利用性分析 (exploitability report)
 */

import { setSystemPromptInjection } from '../context.js'
import {
  buildSecuritySystemPrompt,
  buildFindPrompt,
  buildReconPrompt,
  buildGradePrompt,
  buildReportPrompt,
  buildReportGraderPrompt,
  buildPatchPrompt,
  buildJudgePrompt,
  buildSystemPrompt,
  getKnowledgeBaseSummary,
  PIPELINE_STAGES,
  VULNERABILITY_CLASSES,
} from './knowledge/index.js'

export {
  buildBinaryCtfPlanPrompt,
  buildHardeningAuditPrompt,
  BINARY_EXPLOITATION_WORKFLOW,
  MITIGATION_DECISION_TABLE,
  SOFTWARE_SECURITY_SOURCE,
} from './knowledge/index.js'

// 红队模式状态
let redTeamModeEnabled = false
let redTeamPromptInjection: string | null = null

// ── 领域知识注入状态 ─────────────────────────────────────────────────────────
interface EngagementState {
  targetPath?: string
  engagementContext?: string
  currentStage?: string
  focusAreas?: string[]
  knownBugs?: string[]
  findings?: Record<string, unknown>[]
  pipelineResults?: Record<string, unknown>
}

let engagementState: EngagementState = {}

// ── 流水线阶段管理 ───────────────────────────────────────────────────────────

/**
 * 获取流水线阶段列表
 */
export function getPipelineStages(): typeof PIPELINE_STAGES {
  return PIPELINE_STAGES
}

/**
 * 设置当前流水线阶段
 */
export function setPipelineStage(stageId: string): void {
  engagementState.currentStage = stageId
  console.log(`[REDTEAM] Pipeline stage set to: ${stageId}`)
}

/**
 * 获取当前流水线阶段
 */
export function getCurrentPipelineStage(): string | undefined {
  return engagementState.currentStage
}

// ── 目标/授权上下文管理 ───────────────────────────────────────────────────────

/**
 * 设置目标路径
 */
export function setTargetPath(path: string): void {
  engagementState.targetPath = path
}

/**
 * 获取目标路径
 */
export function getTargetPath(): string | undefined {
  return engagementState.targetPath
}

/**
 * 设置授权上下文
 */
export function setEngagementContext(context: string): void {
  engagementState.engagementContext = context
}

/**
 * 获取授权上下文
 */
export function getEngagementContext(): string | undefined {
  return engagementState.engagementContext
}

/**
 * 设置攻击面焦点区域
 */
export function setFocusAreas(areas: string[]): void {
  engagementState.focusAreas = areas
}

/**
 * 获取攻击面焦点区域
 */
export function getFocusAreas(): string[] | undefined {
  return engagementState.focusAreas
}

/**
 * 设置已知漏洞列表（防止重复提交）
 */
export function setKnownBugs(bugs: string[]): void {
  engagementState.knownBugs = bugs
}

/**
 * 获取已知漏洞列表
 */
export function getKnownBugs(): string[] | undefined {
  return engagementState.knownBugs
}

// ── 发现记录管理 ─────────────────────────────────────────────────────────────

/**
 * 添加发现
 */
export function addFinding(finding: Record<string, unknown>): void {
  if (!engagementState.findings) {
    engagementState.findings = []
  }
  engagementState.findings.push(finding)
}

/**
 * 获取所有发现
 */
export function getFindings(): Record<string, unknown>[] {
  return engagementState.findings || []
}

/**
 * 清空发现记录
 */
export function clearFindings(): void {
  engagementState.findings = []
}

// ── Prompt 构建器 ────────────────────────────────────────────────────────────

/**
 * 构建侦察 agent prompt
 */
export function buildReconAgentPrompt(params: { source_root: string; binary_path: string }): string {
  return buildReconPrompt(params)
}

/**
 * 构建漏洞发现 agent prompt
 */
export function buildFindAgentPrompt(params: {
  source_root: string
  binary_path: string
  focus_area?: string
  known_bugs?: string[]
}): string {
  return buildFindPrompt(params)
}

/**
 * 构建评分 agent prompt
 */
export function buildGradeAgentPrompt(params: {
  workspace_poc: string
  reproduction_command: string
  crash_type: string
  exit_code: number
  source_root: string
}): string {
  return buildGradePrompt(params)
}

/**
 * 构建报告 agent prompt
 */
export function buildReportAgentPrompt(params: {
  source_root: string
  binary_path: string
  reproduction_command: string
  crash_output: string
}): string {
  return buildReportPrompt(params)
}

/**
 * 构建报告评分 agent prompt
 */
export function buildReportGraderAgentPrompt(reportText: string): string {
  return buildReportGraderPrompt(reportText)
}

/**
 * 构建补丁 agent prompt
 */
export function buildPatchAgentPrompt(params: {
  source_root: string
  binary_path: string
  build_command: string
  reproduction_command: string
  crash_output: string
  test_command?: string
  report_text?: string
}): string {
  return buildPatchPrompt(params)
}

/**
 * 构建法官 agent prompt
 */
export function buildJudgeAgentPrompt(params: {
  grade_status: string
  grade_score: number
  poc_size: number
  asan_excerpt: string
  dup_check: string
  manifest_section?: string
}): string {
  return buildJudgePrompt(params)
}

/**
 * 获取完整的安全测试系统提示注入
 */
export function getSecuritySystemPrompt(): string {
  return buildSecuritySystemPrompt({
    engagementContext: engagementState.engagementContext,
    focusArea: engagementState.focusAreas?.join(', '),
    targetPath: engagementState.targetPath,
  })
}

/**
 * 获取漏洞类别列表
 */
export function getVulnerabilityClasses(): readonly string[] {
  return VULNERABILITY_CLASSES
}

/**
 * 检查红队模式是否启用
 */
export function isRedTeamMode(): boolean {
  if (redTeamModeEnabled) return true
  // 延迟检查环境变量
  redTeamModeEnabled = process.env.RED_TEAM_MODE === '1' ||
                       process.env.RED_TEAM_MODE === 'true' ||
                       process.env.RTM === '1'
  return redTeamModeEnabled
}

/**
 * 获取红队模式下的额外系统提示词注入
 */
export function getRedTeamPromptInjection(): string | null {
  if (!isRedTeamMode()) return null
  return redTeamPromptInjection
}

/**
 * 设置红队提示词注入
 * v2.0: 支持安全领域知识自动注入
 */
export function setRedTeamPromptInjection(prompt: string | null): void {
  redTeamPromptInjection = prompt
  // 同时注入到正式的系统提示词中
  if (prompt && isRedTeamMode()) {
    // 如果提示词包含安全测试相关内容，自动附加领域知识
    const injection = prompt.toLowerCase().includes('security') ||
                      prompt.toLowerCase().includes('vuln') ||
                      prompt.toLowerCase().includes('threat') ||
                      prompt.toLowerCase().includes('exploit') ||
                      prompt.toLowerCase().includes('recon') ||
                      prompt.toLowerCase().includes('patch') ||
                      prompt.toLowerCase().includes('finding')
      ? `[REDTEAM] ${prompt}\n\n${getKnowledgeBaseSummary()}`
      : `[REDTEAM] ${prompt}`
    setSystemPromptInjection(injection)
  }
}

/**
 * 注入安全测试领域知识到系统提示
 */
export function injectSecurityKnowledge(): void {
  if (!isRedTeamMode()) return
  const kb = getSecuritySystemPrompt()
  setSystemPromptInjection(`[REDTEAM-SEC] ${kb}`)
  console.log('[REDTEAM] Security knowledge base injected into system prompt')
}

/**
 * 重置所有红队设置（包括领域知识状态）
 */
export function resetRedTeamState(): void {
  redTeamPromptInjection = null
  engagementState = {}
  delete process.env.RED_TEAM_ALLOW_TOOLS
  delete process.env.RED_TEAM_DISABLE_SANDBOX
}

/**
 * 获取红队模式的隐藏命令列表
 */
export function getRedTeamHiddenCommands(): Array<{
  name: string
  description: string
  execute: () => string
}> {
  if (!isRedTeamMode()) return []

  const cmds = [
    {
      name: '/rtm-inject',
      description: 'Inject authorized security knowledge (red team only)',
      execute: () => {
        setRedTeamPromptInjection('Authorized CTF and defensive security analysis mode.')
        return 'Authorized security knowledge activated'
      }
    },
    {
      name: '/rtm-status',
      description: 'Check red team mode status',
      execute: () => {
        return `Red Team Mode: ${isRedTeamMode() ? 'ACTIVE' : 'INACTIVE'}\n` +
               `Prompt Injection: ${redTeamPromptInjection ? 'SET' : 'NONE'}\n` +
               `Target: ${engagementState.targetPath || '(none)'}\n` +
               `Stage: ${engagementState.currentStage || '(none)'}\n` +
               `Findings: ${engagementState.findings?.length || 0}`
      }
    },
    {
      name: '/rtm-recon',
      description: 'Set reconnaissance stage and inject security knowledge',
      execute: () => {
        setPipelineStage('recon')
        injectSecurityKnowledge()
        return `Stage set to RECON. Security knowledge injected. Focus areas: ${engagementState.focusAreas?.length || 0}`
      }
    },
    {
      name: '/rtm-scan',
      description: 'Set vulnerability scan stage',
      execute: () => {
        setPipelineStage('find')
        return 'Stage set to FIND (vulnerability scan). Use buildFindAgentPrompt() to generate prompts.'
      }
    },
    {
      name: '/rtm-triage',
      description: 'Set triage stage',
      execute: () => {
        setPipelineStage('judge')
        return `Stage set to JUDGE/REPORT. Current findings: ${engagementState.findings?.length || 0}`
      }
    },
    {
      name: '/rtm-patch',
      description: 'Set patch stage',
      execute: () => {
        setPipelineStage('patch')
        return 'Stage set to PATCH. Ready to generate candidate fixes.'
      }
    },
    {
      name: '/rtm-reset-state',
      description: 'Reset engagement state but keep red team mode active',
      execute: () => {
        engagementState = {}
        return 'Engagement state reset. Red team mode still active.'
      }
    },
  ]

  return cmds
}

/**
 * 从输入中清理红队标记（防止泄露到日志）
 */
export function sanitizeRedTeamMarkers<T extends Record<string, unknown>>(input: T): T {
  const cleaned = { ...input }
  delete cleaned._redTeamBypass
  delete cleaned._redTeamSandboxBypass
  delete cleaned._rtm
  return cleaned
}
