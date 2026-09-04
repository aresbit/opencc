export const SRE_TOOL_NAME = 'sretool'

export const DESCRIPTION = `SRE/operations actions for the AWR robot pipeline, gated fail-closed.

Actions (selected with \`action\`):

**action: "runbook"** (read-only) — return the built-in AWR operations playbook for a \`topic\` (OTA升级 / 机器人轮换 / 传感器故障 / AIO群控 / Thor部署). Zero risk.

**action: "health"** (read-only) — read-only remote health check over an SSH \`session\`: process count, uptime, disk. Never writes.

**action: "investigate"** (read-only) — grep remote logs for a \`pattern\` (default /apollo/data/log). Never writes.

**action: "deploy" / "rollback" / "ota"** (destructive, gated) — build a command plan. Default \`dry_run: true\` only returns the plan; \`dry_run: false\` requires explicit user approval (isDestructive + permission prompt) before anything executes, and every execution writes an audit entry.

**action: "report"** (read-only) — render a structured incident report from impact / hypothesis / evidence / next_step.

SECURITY (hard line): destructive actions default to dry-run. Executing them requires explicit user approval; timeouts/disconnects are treated as deny. Robot runtime operations must NOT use sudo — run as the nvidia user. Quality checks/calibration must be serial, never looped. All robot operations go through ehmi_client.py, never ad-hoc scripts.`

export const SAFETY_RULES_PROMPT = `AWR safety rules (always apply):
1. Quality checks (quality-check) must run serially — one completes before the next; never batch them in a loop.
2. Robot operations (lock/calibrate/quality-check/start-job/trajectory/reset) go through ehmi_client.py only. Do not write new scripts that talk to the robot over WebSocket.
3. Runtime/application operations (bash awr_*.run, start_awr.sh, ehmi/job) must NOT use sudo — run as the nvidia user. Exceptions: tars_flash, systemctl, writing system paths, apt/sysctl/iptables.
4. Destructive actions (deploy/rollback/ota) default to dry-run; execute only after the user explicitly approves.`

export function getPrompt() {
  return `Use \`sretool\` for AWR robot-pipeline operations with a fail-closed gate.

- Prefer \`runbook\` to recall the exact procedure for a task before acting.
- Use \`health\` / \`investigate\` for read-only diagnosis (these never write).
- For \`deploy\` / \`rollback\` / \`ota\`, first call with the default \`dry_run: true\` to see the plan; only set \`dry_run: false\` after the user approves — the permission system will prompt again.
- Finish an investigation with \`report\`, quoting log/status lines verbatim in \`evidence\` (do not paraphrase).

${SAFETY_RULES_PROMPT}`
}
