export const REPO_TO_SKILL_TOOL_NAME = 'repo2skill'

export const DESCRIPTION = `Distill a GitHub repository (or a task) into a reusable skill, and register it so the agent can invoke it later.

This tool does the deterministic scaffolding around repo-to-skill distillation, selected with \`action\`:

**action: "distill"** (default) — safely clones a repository (git clone --depth 1, no build scripts are ever run) into a workspace under the opencc config home, detects its type (CLI tool / library / config / docs) by reading its manifest (package.json / pyproject.toml / Cargo.toml / go.mod / README), and returns a distillation brief: repo type, entry points, key files worth reading, and install/usage hints. It does NOT author the skill — that is your work. Read the brief (and the cloned files) to write a SKILL.md, then call \`register\`.

**action: "register"** — writes a skill into the user skill store and hot-loads it so it is immediately invocable via the Skill tool in this session and auto-discovered in future sessions. Supply either \`skillContent\` (the full SKILL.md markdown, frontmatter included) or \`skillDir\` (a directory you already wrote containing SKILL.md, optionally references/ and scripts/).

**action: "list"** — lists the repo-skills already registered by this tool.

The distilled skill is a prompt command (SKILL.md + optional references/ + scripts/), not a deterministic Tool: it carries the "how to make it work" operational knowledge — install, API, gotchas, verification — as progressive-disclosure markdown. Keep the frontmatter \`description\` under ~250 characters (it is shown in the skill listing).

SECURITY (hard line): opencc runs on the user's real machine with no container isolation. Clone never executes anything; the tool never runs install scripts, Makefiles, or the repository's own code. Verification commands, if any, are run by you through BashTool under the normal permission gate. Unknown repositories should be statically distilled only.`

export function getPrompt() {
  return `Use \`repo2skill\` when the user wants a GitHub repository turned into a reusable capability (a skill) that the agent can invoke later.

Three phases:

1. **Distill first.** Call it with the repo URL (optionally a \`task\` describing what capability to extract). Read the returned brief, then read the key files it names in the cloned workspace. Write a SKILL.md — self-contained, "how to use / install / call / verify / gotchas" — and put it under the workspace, then register it.

2. **Register.** Call \`repo2skill\` action "register" with \`skillDir\` pointing at the directory holding your SKILL.md (or pass \`skillContent\` inline). The tool writes it into the skill store and hot-loads it. After this, the skill is available as a Skill command this session and is auto-discovered next session.

3. **Verify, honestly.** Do not claim a skill "works" unless its install/usage instructions were actually exercised. If the repository's tests were not run (static distillation only), say so in the SKILL.md and record it as a gap — do not fabricate a passing verification.

Report the registered skill name and path. Do not restate an unverified skill as verified.`
}
