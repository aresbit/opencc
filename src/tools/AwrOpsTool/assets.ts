/**
 * Bundled asset registry for the AwrOpsTool.
 *
 * Every file under ./assets/ is imported as inline text via Bun's
 * `with { type: 'text' }` import attribute. At build time the bundler
 * inlines each file's contents as a string constant, so the tool carries
 * its own documentation and scripts inside the single-file bundle with no
 * runtime dependency on ~/.claude/skills/awr-ops/ (or any external path).
 *
 * To add a new reference or script: drop the file under ./assets/ and add a
 * matching import + entry below. The AwrOpsTool.ts action handlers read
 * from these arrays exclusively.
 */

// --- Main guide ---
import skillMd from './assets/SKILL.md' with { type: 'text' }

// --- Reference documents (canonical order; the tool's `reference` action
// validates against this list, so adding here is what exposes it to the model) ---
import awrOpsDeployGuide from './assets/references/awr-ops-deploy-guide.md' with { type: 'text' }
import awrBuild from './assets/references/awr-build.md' with { type: 'text' }
import ehmiProtocol from './assets/references/ehmi-protocol.md' with { type: 'text' }
import ehmiScriptingGuide from './assets/references/ehmi-scripting-guide.md' with { type: 'text' }
import stTestSop from './assets/references/st-test-sop.md' with { type: 'text' }

// --- Scripts ---
import ehmiClientPy from './assets/scripts/ehmi/ehmi_client.py' with { type: 'text' }

export interface ReferenceAsset {
  /** Stable identifier (no .md suffix) used by the `reference` action. */
  name: string
  /** Logical asset path inside the tool directory — useful for attribution. */
  path: string
  /** Document body with YAML frontmatter stripped. */
  content: string
}

export interface ScriptAsset {
  /** Stable identifier used by the `script` action. */
  name: string
  /** Logical asset path inside the tool directory. */
  path: string
  /** Language hint for syntax-aware consumers / temp-file extensions. */
  language: 'python' | 'bash' | 'text'
  /** Suggested filename when the model writes this to a temp dir for execution. */
  suggestedFilename: string
  /** Raw script source (frontmatter NOT stripped — scripts are executable as-is). */
  content: string
}

/**
 * Strip a leading YAML frontmatter block (---\n...\n---) so returned docs are
 * clean body text. Mirrors SkillTool's parseFrontmatter behavior. Scripts are
 * returned verbatim (no frontmatter stripping) so they remain runnable.
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4).replace(/^\r?\n/, '')
}

const REFERENCES: ReferenceAsset[] = [
  {
    name: 'awr-ops-deploy-guide',
    path: 'assets/references/awr-ops-deploy-guide.md',
    content: stripFrontmatter(awrOpsDeployGuide),
  },
  {
    name: 'awr-build',
    path: 'assets/references/awr-build.md',
    content: stripFrontmatter(awrBuild),
  },
  {
    name: 'ehmi-protocol',
    path: 'assets/references/ehmi-protocol.md',
    content: stripFrontmatter(ehmiProtocol),
  },
  {
    name: 'ehmi-scripting-guide',
    path: 'assets/references/ehmi-scripting-guide.md',
    content: stripFrontmatter(ehmiScriptingGuide),
  },
  {
    name: 'st-test-sop',
    path: 'assets/references/st-test-sop.md',
    content: stripFrontmatter(stTestSop),
  },
]

const SCRIPTS: ScriptAsset[] = [
  {
    name: 'ehmi-client',
    path: 'assets/scripts/ehmi/ehmi_client.py',
    language: 'python',
    suggestedFilename: 'ehmi_client.py',
    content: ehmiClientPy,
  },
]

/** Main deployment guide body (frontmatter stripped). */
export const GUIDE: string = stripFrontmatter(skillMd)

/** Logical path of the main guide, for attribution. */
export const GUIDE_PATH = 'assets/SKILL.md'

export function getReference(name: string): ReferenceAsset | undefined {
  const trimmed = name.trim().replace(/\.md$/i, '')
  return REFERENCES.find(r => r.name === trimmed)
}

export function listReferences(): ReadonlyArray<ReferenceAsset> {
  return REFERENCES
}

export function getScript(name: string): ScriptAsset | undefined {
  const trimmed = name.trim()
  return SCRIPTS.find(
    s => s.name === trimmed || s.suggestedFilename === trimmed,
  )
}

export function listScripts(): ReadonlyArray<ScriptAsset> {
  return SCRIPTS
}
