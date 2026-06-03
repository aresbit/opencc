/**
 * RTM Knowledge Base — 红队领域知识总入口
 * 整合 rtm-harness 的漏洞发现/验证/修复全流程领域知识
 */

export * from './prompts.js'
export * from './vuln-scan.js'
export * from './triage.js'
export * from './threat-model.js'

/**
 * 领域知识版本号，用于缓存失效和兼容性检查
 */
export const RTM_KNOWLEDGE_VERSION = '1.0.0'

/**
 * 流水线阶段定义
 */
export const PIPELINE_STAGES = [
  { id: 'recon', name: 'Reconnaissance', description: 'Partition attack surface into focus areas' },
  { id: 'find', name: 'Find', description: 'Parallel agents hunt crashes per focus area' },
  { id: 'grade', name: 'Grade', description: 'Verify crash reproduces in fresh container' },
  { id: 'judge', name: 'Judge', description: 'Decide NEW / DUP_BETTER / DUP_SKIP' },
  { id: 'report', name: 'Report', description: 'Structured exploitability analysis' },
  { id: 'patch', name: 'Patch', description: 'Generate and verify candidate fixes' },
] as const

/**
 * 支持的漏洞类别
 */
export const VULNERABILITY_CLASSES = [
  'heap-buffer-overflow',
  'stack-buffer-overflow',
  'global-buffer-overflow',
  'heap-use-after-free',
  'double-free',
  'integer-overflow',
  'format-string',
  'sql-injection',
  'command-injection',
  'path-traversal',
  'deserialization',
  'xss',
  'auth-bypass',
  'hardcoded-secret',
  'weak-crypto',
  'toctou',
  'unbounded-recursion',
  'redos',
  'info-disclosure',
  'race-condition',
  'securit-misconfiguration',
  'broken-access-control',
  'cryptographic-failure',
  'insecure-design',
  'ssrf',
  'xxe',
  'csrF',
] as const

/**
 * 严重级别定义
 */
export const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const

/**
 * ASAN 崩溃类型映射
 */
export const ASAN_CRASH_TYPES = [
  'heap-buffer-overflow',
  'stack-buffer-overflow',
  'global-buffer-overflow',
  'heap-use-after-free',
  'double-free',
  'memory-leak',
  'SEGV',
  'ABRT',
  'allocation-size-too-big',
] as const

/**
 * 获取知识库摘要（用于系统提示注入）
 */
export function getKnowledgeBaseSummary(): string {
  return `\
RTM Harness Knowledge Base v${RTM_KNOWLEDGE_VERSION}

Pipeline stages: ${PIPELINE_STAGES.map(s => s.id).join(' -> ')}

Vulnerability classes (${VULNERABILITY_CLASSES.length}):
- Memory safety: heap/stack/global buffer overflow, use-after-free, double-free, integer overflow
- Injection: SQL, command, path traversal, deserialization, XSS, XXE, SSRF
- Auth/crypto: auth-bypass, hardcoded-secret, weak-crypto, broken-access-control
- Logic: TOCTOU, race-condition, unbounded-recursion, ReDoS, info-disclosure

Severity levels: ${SEVERITY_LEVELS.join(', ')}

Key principles:
1. Recon partitions attack surface into independent focus areas
2. Find agents validate crashes 3/3 before submission
3. Grade verifies in fresh container (not find-agent's environment)
4. Judge distinguishes root cause from crash class
5. Report covers primitive, reachability, heap_layout, escalation_path, constraints
6. Patch fixes root cause (not crash site), verified by rebuild + re-attack
`
}

/**
 * 构建完整的安全测试系统提示
 */
export function buildSecuritySystemPrompt(options?: {
  engagementContext?: string
  focusArea?: string
  targetPath?: string
}): string {
  const base = getKnowledgeBaseSummary()
  let extra = ''

  if (options?.engagementContext) {
    extra += `\n## Engagement Context\n${options.engagementContext}\n`
  }
  if (options?.focusArea) {
    extra += `\n## Focus Area\n${options.focusArea}\n`
  }
  if (options?.targetPath) {
    extra += `\n## Target\n${options.targetPath}\n`
  }

  return base + extra
}
