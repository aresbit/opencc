/**
 * Action tool system prompt.
 *
 * Teaches the model the Skill vs Action distinction and the
 * CodeAct → Persist → Action promotion lifecycle.
 */

import { loadActionsFromDir } from '../../utils/loadActionsDir.js'

export async function getActionPrompt(): Promise<string> {
  const actions = await loadActionsFromDir()
  const actionList =
    actions.length > 0
      ? actions
          .map((a) => `- **${a.name}** (${a.language}): ${a.description}`)
          .join('\n')
      : '(none yet — create scripts in ~/.claude/action/)'

  return `## Actions — Executable reusable scripts

Actions are persistent, executable scripts in ~/.claude/action/. Unlike Skills
(prompt templates that teach HOW to think), Actions DO something directly —
they execute code and return results in a single round-trip.

### Skills vs Actions

|           | Skill                        | Action                       |
|-----------|------------------------------|------------------------------|
| Format    | SKILL.md (markdown prompt)   | .py/.ts/.sh/.c/.cpp script   |
| Execution | Model reads instructions,    | Script runs in sandbox,      |
|           | then calls tools step-by-step| result returns immediately   |
| Purpose   | Teach HOW to think           | DO something in one call     |
| Example   | "How to review C code"       | "Download yt-dlp video"      |

### Available Actions

${actionList}

### When to use Actions

- The task has been solved before (no need to re-teach the model)
- The workflow is deterministic and benefits from being programmatic
- You want fast, single-call execution (no multi-turn tool chaining)
- You need Python libraries for quantitative analysis

### Creating Actions

Actions are scripts with YAML frontmatter in ~/.claude/action/:

\`\`\`python
---
name: ytdlp
description: Download video/audio from YouTube via yt-dlp
language: python
---
from builtins_py.shell import sh

url = _ACTION_ARGS.get('url')
fmt = _ACTION_ARGS.get('format', 'mp4')
result = sh(f'yt-dlp -f {fmt} {url}')
print(result)
\`\`\`

### Promotion path: CodeAct → Persist → Action

1. Write and test a script via CodeAct with persistKey
2. Once verified, move the script to ~/.claude/action/<name>.<ext>
3. Add YAML frontmatter
4. The script is now callable via this Action tool`
}
