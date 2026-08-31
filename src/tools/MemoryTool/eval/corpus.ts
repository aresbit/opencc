/**
 * Labeled retrieval corpus for the MemoryTool eval.
 *
 * Deliberately small and hand-labeled. The point is not statistical power —
 * it is that every case here is a failure mode that was actually observed, so
 * a regression on any single one is a real regression. Cases are grouped by
 * the property they test; add a case whenever a recall bug is found, before
 * fixing it.
 */

import type { MemoryType } from '../../../memdir/memoryTypes.js'

export type CorpusMemory = {
  id: string
  type: MemoryType
  name: string
  description: string
  content: string
  tags?: string[]
  /** ISO date after which the memory is stale. Exercises the demotion path. */
  staleAfter?: string
}

export type EvalCase = {
  /** What this case is testing, for the failure report. */
  label: string
  query: string
  /** Memory ids that a good ranker puts in the top results, best first. */
  expected: string[]
  /**
   * True when the correct answer is "nothing". Distractor queries catch the
   * ranker that matches everything — the failure mode of the original
   * substring-OR search, which scored perfectly on recall and was useless.
   */
  distractor?: boolean
}

export const CORPUS: CorpusMemory[] = [
  {
    id: 'project_deepseek-prefix-cache',
    type: 'project',
    name: 'DeepSeek byte-level prefix cache optimization',
    description: 'Byte-level prefix cache reuse implemented in DeepSeekPrefixOptimizer',
    content:
      'The DeepSeek request path reuses a byte-level prefix cache so that a stable prompt prefix hits KV cache across turns. Tool definitions must be ordered deterministically or the prefix diverges.',
    tags: ['deepseek', 'cache', 'performance'],
  },
  {
    id: 'project_deepseek-known-gaps',
    type: 'project',
    name: 'DeepSeek optimizer known gaps',
    description: 'Open design gaps after the audit: tool ordering, dormant APIs, warmup wiring',
    content:
      'Three gaps remain in the optimizer: tool ordering is not yet stable across sessions, several APIs are defined but never called, and warmup is not wired into startup.',
    tags: ['deepseek', 'audit', 'todo'],
  },
  {
    id: 'feedback_prefer-chinese',
    type: 'feedback',
    name: '用中文回复',
    description: '用户要求所有回复使用中文',
    content:
      '用户要求所有对话回复使用中文。\n**Why:** 用户的母语是中文，阅读效率更高。\n**How to apply:** 除代码与标识符外，正文一律用中文。',
    tags: ['language', 'style'],
  },
  {
    id: 'feedback_no-agent-spawn',
    type: 'feedback',
    name: 'Do not spawn subagents unprompted',
    description: 'Handle multi-part tasks inline instead of spawning agents',
    content:
      'Do not spawn subagents unless explicitly asked.\n**Why:** each spawn starts cold and re-derives context, which is the expensive path.\n**How to apply:** a task with several parts is not a request to spawn.',
    tags: ['agents', 'workflow'],
  },
  {
    id: 'user_role',
    type: 'user',
    name: 'User is an EECS PhD',
    description: 'INTJ EECS PhD from UCB, expert software developer',
    content:
      'The user is an INTJ EECS PhD from UC Berkeley and an expert software developer. Prefers frank, dense technical answers with no hand-holding.',
    tags: ['profile'],
  },
  {
    id: 'reference_wiki-hooks',
    type: 'reference',
    name: 'Claude Code hooks documentation',
    description: 'Hooks reference lives at code.claude.com/docs, search for hooks',
    content:
      'The Claude Code hooks reference is at https://code.claude.com/docs — search "hooks". Covers PreToolUse, PostToolUse, Stop and the settings.json wiring.',
    tags: ['docs', 'hooks'],
  },
  {
    id: 'project_rnnoise-training',
    type: 'project',
    name: 'RNNoise 降噪模型训练进展',
    description: 'GRU 修复与数据合成完成，训练管线可跑通',
    content:
      'RNNoise 降噪模型训练项目：GRU 层的初始化问题已修复，噪声数据合成脚本完成。下一步是评估 PESQ 分数。',
    tags: ['rnnoise', 'training', 'audio'],
  },
  {
    id: 'project_cdp-workflow',
    type: 'project',
    name: 'Chrome CDP web search workflow',
    description: 'Efficient sequence for driving web search through the Chrome CDP tool',
    content:
      'Navigate first, then read_page rather than screenshot, then extract with get_page_text. Screenshots are the slow path and should be a last resort.',
    tags: ['chrome', 'cdp', 'search'],
  },
  // An overcome belief and the successor that replaced it. The successor must
  // outrank the overcome memory, but the overcome one must stay findable.
  {
    id: 'project_cache-strategy-old',
    type: 'project',
    name: 'Cache invalidation strategy',
    description: '[OVERCOME] Invalidate the whole prompt cache on any tool change',
    content:
      'We invalidate the entire prompt cache whenever any tool definition changes.',
    tags: ['cache', 'overcome', 'genealogy'],
  },
  {
    id: 'project_cache-strategy-new',
    type: 'project',
    name: 'Cache invalidation strategy (evolved)',
    description: 'Only the suffix after the changed tool is invalidated',
    content:
      'Cache invalidation is now prefix-scoped: only the suffix after the first changed tool definition is dropped, so unrelated tool edits keep the cache warm.',
    tags: ['cache', 'evolved', 'overcomes:project_cache-strategy-old'],
  },
  // A name whose identifier runs two words together. A query that also runs
  // them together tokenizes as one term and matches nothing exactly — the one
  // case the character n-gram soft match demonstrably rescues.
  {
    id: 'project_feishu-api-limit',
    type: 'project',
    name: 'feishu_api rate limit handling',
    description: 'Backoff and retry policy for the feishu_api rate limiter',
    content:
      'The feishu_api rate limiter returns 429 with a Retry-After header. Honour it rather than backing off blindly, and never retry a non-idempotent call.',
    tags: ['feishu', 'ratelimit'],
  },
  // A belief the user gave a finite lifetime, and the one that supersedes it.
  // The stale one must stay findable and must not outrank the fresh one.
  {
    id: 'project_kafka-lag-incident',
    type: 'project',
    // Deliberately the better exact match for the query below: without the
    // staleness demotion this outranks the permanent fix, which is the
    // behaviour the demotion exists to correct.
    name: 'Kafka consumer lag',
    description: 'Temporary mitigation while the kafka consumer lag incident was open',
    content:
      'During the incident, consumer lag was mitigated by pausing the enrichment stage. This is a stopgap tied to the open incident.',
    tags: ['kafka', 'incident'],
    staleAfter: '2020-01-01T00:00:00.000Z',
  },
  {
    id: 'project_kafka-lag-fix',
    type: 'project',
    name: 'Partition rebalance for consumer lag',
    description: 'Partition rebalance settled the kafka lag for good',
    content:
      'Consumer lag was resolved by raising the partition count and rebalancing. The enrichment stage no longer needs pausing.',
    tags: ['kafka', 'resolved'],
  },
]

export const CASES: EvalCase[] = [
  {
    label: 'exact topic word in name',
    query: 'deepseek prefix cache',
    expected: ['project_deepseek-prefix-cache', 'project_deepseek-known-gaps'],
  },
  {
    label: 'CJK query against CJK memory',
    query: '中文回复',
    expected: ['feedback_prefer-chinese'],
  },
  {
    label: 'CJK query, mixed-script memory',
    query: 'RNNoise 训练进展',
    expected: ['project_rnnoise-training'],
  },
  {
    label: 'CJK + latin in one token',
    query: 'deepseek缓存',
    expected: ['project_deepseek-prefix-cache'],
  },
  {
    label: 'stopword-heavy natural question',
    query: 'how should I be replying to this user',
    expected: ['feedback_prefer-chinese', 'user_role'],
  },
  {
    label: 'body-only match',
    query: 'PESQ score',
    expected: ['project_rnnoise-training'],
  },
  {
    label: 'tag match',
    query: 'hooks',
    expected: ['reference_wiki-hooks'],
  },
  {
    label: 'successor outranks the belief it overcame',
    query: 'cache invalidation strategy',
    expected: ['project_cache-strategy-new', 'project_cache-strategy-old'],
  },
  {
    label: 'subagent guidance',
    query: 'should I spawn a subagent for this',
    expected: ['feedback_no-agent-spawn'],
  },
  {
    label: 'screenshot vs read_page',
    query: 'chrome screenshot slow',
    expected: ['project_cdp-workflow'],
  },
  // The query is the run-together token alone on purpose. With `rate limit`
  // appended, those terms match exactly and the case passes either way —
  // it would look like a test and assert nothing.
  {
    label: 'run-together query against an underscored identifier',
    query: 'feishuapi',
    expected: ['project_feishu-api-limit'],
  },
  {
    label: 'a stale belief stays findable but loses to its replacement',
    query: 'kafka consumer lag',
    expected: ['project_kafka-lag-fix', 'project_kafka-lag-incident'],
  },
  // Distractors — a ranker that returns anything here is over-matching.
  {
    label: 'distractor: unrelated domain',
    query: 'kubernetes ingress controller',
    expected: [],
    distractor: true,
  },
  // Guards the soft match specifically: lexically close to the hooks memory
  // ("hoo", "ook" grams) and about something else entirely. A fuzzy signal
  // that answers this is the over-matching failure the whole eval exists for.
  {
    label: 'distractor: string-similar to a real memory, unrelated meaning',
    query: 'hookah lounge setup',
    expected: [],
    distractor: true,
  },
  {
    label: 'distractor: generic filler',
    query: 'what should we do about this thing',
    expected: [],
    distractor: true,
  },
]
