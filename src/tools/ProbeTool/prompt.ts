export const PROBE_TOOL_NAME = 'probetool'

export const DESCRIPTION = `Security probe for targets the user has explicitly authorized. Records findings to a local ledger with a verification gate.

Actions (selected with \`action\`):

**action: "authorize"** — add a target to the authorized-targets allowlist. This is the ONLY way to expand probing scope. Required before scan/verify/fix. Provide a \`scope\` stating who, what, and where it stops.

**action: "scan"** — read-only reconnaissance of an authorized target (a local path or repo). Detects its surface (manifests, file types) and records coverage. It does NOT run any build/install code. The actual static audit is your work — use FileRead/Grep/Glob to find sources and sinks, then report each candidate via \`verify\`.

**action: "verify"** — record a finding into the ledger, gated. A finding must carry non-empty \`evidence\` AND \`counterevidence\` (the strongest reason it might NOT be real) to be recorded as verified. \`confidence: "high"\` additionally requires an executed \`poc\`; without one, cap confidence at "medium". Findings without evidence stay "candidate".

**action: "fix"** — attach remediation to a verified finding (optionally with fix_before/fix_after code_locations for white-box findings).

**action: "report"** — read the findings ledger.

SECURITY (hard line): opencc runs on the user's real machine with no container isolation. Every probing action first checks the authorized-targets allowlist and refuses (unauthorized) otherwise. Probing is read-only by default. PoC execution is dry-run by default and high-severity payloads (RCE / arbitrary file write / destructive SQLi) are NEVER auto-executed. Authorized-use only — unauthorized testing is illegal in most jurisdictions.`

export function getPrompt() {
  return `Use \`probetool\` for a bounded, authorized security self-check of a target — not an automated red-team run.

Workflow:
1. **Authorize first.** Call \`probetool\` action "authorize" with the target and a scope. Nothing else works without this.
2. **Scan + audit.** Call action "scan" to record the target's surface, then read the code yourself (FileRead/Grep/Glob) to trace sources to sinks.
3. **Verify each candidate.** Call action "verify" per finding. You MUST supply both \`evidence\` and \`counterevidence\` (the strongest reason the finding might be a false positive). Set \`confidence\` honestly: "high" only with an executed PoC; otherwise "medium" (strong static evidence) or "low" (gaps).
4. **Fix.** For verified findings, call action "fix" with a remediation, and for white-box findings the fix_before/fix_after edits (applied via FileEdit under the normal permission gate, never automatically).
5. **Report.** Call action "report" to read back the ledger.

Do not claim a finding is verified unless evidence + counterevidence were recorded and the PoC (if high) actually ran. Do not probe anything not in the allowlist.`
}
