/**
 * Bundled asset registry for the CombinatoricsMasterTool.
 *
 * Every file under ./assets/ is imported as inline text via Bun's
 * `with { type: 'text' }` import attribute. At build time the bundler
 * inlines each file's contents as a string constant, so the tool carries
 * its own combinatorial-mathematics knowledge inside the single-file
 * bundle with no runtime dependency on any external path (or any other
 * machine's knowledge base).
 *
 * To add a new reference: drop the file under ./assets/references/ and add
 * a matching import + entry below. The CombinatoricsMasterTool.ts action
 * handlers read from these arrays exclusively.
 */

// --- Main guide ---
import skillMd from './assets/SKILL.md' with { type: 'text' }

// --- Reference documents (canonical order; the tool's `reference` action
// validates against this list, so adding here is what exposes it to the model) ---
import countingAndGeneratingFunctions from './assets/references/counting-and-generating-functions.md' with { type: 'text' }
import graphStructuresAndMatching from './assets/references/graph-structures-and-matching.md' with { type: 'text' }
import ramseyAndProbabilisticMethod from './assets/references/ramsey-and-probabilistic-method.md' with { type: 'text' }
import extremalGraphTheory from './assets/references/extremal-graph-theory.md' with { type: 'text' }
import regularityAndGraphLimits from './assets/references/regularity-and-graph-limits.md' with { type: 'text' }
import spectralMethods from './assets/references/spectral-methods.md' with { type: 'text' }
import additiveCombinatorics from './assets/references/additive-combinatorics.md' with { type: 'text' }

export interface ReferenceAsset {
  /** Stable identifier (no .md suffix) used by the `reference` action. */
  name: string
  /** Logical asset path inside the tool directory — useful for attribution. */
  path: string
  /** Document body with YAML frontmatter stripped. */
  content: string
}

/**
 * Strip a leading YAML frontmatter block (---\n...\n---) so returned docs are
 * clean body text. Mirrors SkillTool's parseFrontmatter behavior.
 */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4).replace(/^\r?\n/, '')
}

const REFERENCES: ReferenceAsset[] = [
  {
    name: 'counting-and-generating-functions',
    path: 'assets/references/counting-and-generating-functions.md',
    content: stripFrontmatter(countingAndGeneratingFunctions),
  },
  {
    name: 'graph-structures-and-matching',
    path: 'assets/references/graph-structures-and-matching.md',
    content: stripFrontmatter(graphStructuresAndMatching),
  },
  {
    name: 'ramsey-and-probabilistic-method',
    path: 'assets/references/ramsey-and-probabilistic-method.md',
    content: stripFrontmatter(ramseyAndProbabilisticMethod),
  },
  {
    name: 'extremal-graph-theory',
    path: 'assets/references/extremal-graph-theory.md',
    content: stripFrontmatter(extremalGraphTheory),
  },
  {
    name: 'regularity-and-graph-limits',
    path: 'assets/references/regularity-and-graph-limits.md',
    content: stripFrontmatter(regularityAndGraphLimits),
  },
  {
    name: 'spectral-methods',
    path: 'assets/references/spectral-methods.md',
    content: stripFrontmatter(spectralMethods),
  },
  {
    name: 'additive-combinatorics',
    path: 'assets/references/additive-combinatorics.md',
    content: stripFrontmatter(additiveCombinatorics),
  },
]

/** Main guide body (frontmatter stripped). */
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
