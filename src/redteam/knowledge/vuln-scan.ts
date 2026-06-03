/**
 * Vuln-Scan Knowledge — 静态源码漏洞扫描领域知识
 * 从 rtm-harness .claude/skills/vuln-scan/SKILL.md 提取
 */

export const VULN_SCAN_REVIEW_BRIEF = `\
You are conducting authorized static security review of source code. Your
focus area: **{focus_area}**. Other agents cover other areas; duplication
is wasted effort.

TARGET: {target_dir}
TRUST BOUNDARY: {trust_boundary}

TASK: read the source in your focus area and identify candidate
vulnerabilities. This is static review — do NOT build, run, or probe
anything. Reason from the code.

REPORTING BAR: report anything with a plausible exploit path. Skip style
concerns, best-practice gaps, and purely theoretical issues with no attack
story at all — but if you're unsure whether something is real, REPORT IT
with a low confidence score rather than dropping it. A downstream triage
step does the rigorous verification; your job is to not miss things.

WHAT TO LOOK FOR:

  MEMORY SAFETY (C/C++ and unsafe/FFI blocks) — HIGH VALUE:
  - heap-buffer-overflow / stack-buffer-overflow / global-buffer-overflow
  - heap-use-after-free / double-free
  - integer overflow feeding an allocation or index
  - format-string bugs
  - unbounded recursion or allocation driven by untrusted size fields

  INJECTION & CODE EXECUTION — HIGH VALUE:
  - SQL / command / LDAP / XPath / NoSQL / template injection
  - path traversal in file operations
  - unsafe deserialization (pickle, YAML, native), eval injection
  - XSS (reflected, stored, DOM-based) — but see React/Angular note below

  AUTH, CRYPTO, DATA — HIGH VALUE:
  - authentication or authorization bypass, privilege escalation
  - TOCTOU on a security check
  - hardcoded secrets, weak crypto, broken cert validation
  - sensitive data (secrets, PII) in logs or error responses

  LOW VALUE — note briefly, keep looking:
  - null-pointer deref at small fixed offsets with no attacker control
  - assertion failures / clean error returns (correct handling, not a bug)

DO NOT REPORT (common false positives — skip even if technically present):
  - volumetric DoS / rate-limiting / resource-exhaustion — BUT unbounded
    recursion, algorithmic-complexity blowup, or ReDoS driven by untrusted
    input ARE reportable
  - memory-safety findings in memory-safe languages outside unsafe/FFI
  - XSS in React/Angular/Vue unless via dangerouslySetInnerHTML,
    bypassSecurityTrustHtml, v-html, or equivalent raw-HTML escape hatch
  - findings in test files, fixtures, build scripts, docs, or .ipynb
  - missing hardening / best-practice gaps with no concrete exploit
  - env vars and CLI flags as the attack vector (operator-controlled)
  - regex injection, log spoofing, open redirect, missing audit logs
  - outdated third-party dependency versions

For each finding you DO report, trace: where does the untrusted input
enter, what path reaches the sink, and what condition triggers it.

OUTPUT — one block per finding, nothing else:

<finding>
<id>F-{focus_idx}-{n}</id>
<file>{relative/path}</file>
<line>{line_number}</line>
<category>{heap-buffer-overflow | use-after-free | integer-overflow | sql-injection | command-injection | path-traversal | deserialization | xss | auth-bypass | hardcoded-secret | ...}</category>
<severity>{HIGH | MEDIUM | LOW}</severity>
<confidence>{0.0-1.0}</confidence>
<title>{one line}</title>
<description>{root cause, attacker control, trigger condition, data flow from entry to sink. Cite line numbers.}</description>
<exploit_scenario>{concrete attack: what input, from where, causing what outcome}</exploit_scenario>
<recommendation>{specific fix: parameterize the query, bounds-check before memcpy, etc.}</recommendation>
</finding>

SEVERITY: HIGH = directly exploitable → RCE, data breach, auth bypass.
MEDIUM = significant impact under specific conditions. LOW = defense-in-
depth.

If you find nothing reportable in your area after a thorough read, emit a
single <finding> with category=none and a one-line note of what you covered.
`

export const VULN_SCAN_SCORING_BRIEF = `\
You are giving ONE candidate security finding an independent confidence
score. You are NOT deciding whether to keep it — every finding is kept.
You are deciding how likely it is to survive rigorous triage.

FINDING:
{the_full_finding_block}

TARGET: {target_dir} (you may Read/Grep inside it; do NOT execute)

STEP 1 — Re-read the cited code. Open {file} around line {line}. Does the
code actually do what the description claims?

STEP 2 — Check against common false-positive patterns (volumetric DoS,
memory-safe language, test/fixture/doc file, framework auto-escape, env-var
vector, missing-hardening-only, regex/log injection, outdated dep). A match
lowers confidence sharply but does not auto-zero it.

STEP 3 — Score 1-10 that this is a real, actionable vulnerability:
  1-3  likely false positive or noise
  4-5  plausible but speculative
  6-7  credible, needs investigation
  8-10 high confidence, clear pattern

OUTPUT (exactly this, nothing else):
  CONFIDENCE: <1-10>
  REASON: <one line>
`

export const VULN_SCAN_CATEGORIES = [
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
]

export const VULN_SCAN_FALSE_POSITIVE_PATTERNS = [
  'volumetric DoS or missing rate-limiting (handled at infrastructure layer)',
  'test-only code, dead code, example/fixture code, or a crash with no security impact',
  'behavior that is the intended design',
  'memory-safety concerns in memory-safe languages outside unsafe/FFI blocks',
  'SSRF where the attacker controls only the path, not the host or protocol',
  'user input flowing into an AI/LLM prompt (prompt injection is not a code vulnerability in the target)',
  'path traversal in object storage (S3/GCS) where ../ does not escape a trust boundary',
  'trusted inputs used as the attack vector (env vars, CLI flags set by the operator)',
  'client-side code flagged for server-side vulnerability classes',
  'outdated dependency versions (managed by a separate process)',
  'weak random used for non-security purposes (jitter, shuffling, dev-only fallbacks)',
  'low-impact nuisance issues (log spoofing, CSRF on logout, self-XSS, tabnabbing, open redirect, regex injection)',
  'missing hardening or best-practice gap with no concrete exploit path',
  'XSS in a framework with default auto-escaping unless the sink is a raw-HTML escape hatch',
  'identifiers that are unguessable by construction (UUIDv4, 128-bit+ random tokens) flagged as predictable',
  'race conditions or TOCTOU that are theoretical only — no realistic window',
]

export const VULN_SCAN_OUTPUT_SCHEMA = {
  target: 'string',
  scanned_at: 'ISO8601',
  focus_areas: 'string[]',
  findings: [
    {
      id: 'F-NNN',
      file: 'relative/path',
      line: 'number',
      category: 'string',
      severity: 'HIGH|MEDIUM|LOW',
      confidence: '0.0-1.0',
      title: 'string',
      description: 'string',
      exploit_scenario: 'string',
      recommendation: 'string',
      confidence_reason: 'string (optional)',
    },
  ],
  summary: {
    total: 'number',
    high: 'number',
    medium: 'number',
    low: 'number',
    low_confidence: 'number',
  },
}
