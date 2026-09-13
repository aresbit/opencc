/**
 * Bundled asset registry for the AnalysisMasterTool.
 *
 * Every file under ./assets/ is imported as inline text via Bun's
 * `with { type: 'text' }` import attribute. At build time the bundler
 * inlines each file's contents as a string constant, so the tool carries
 * its own documentation inside the single-file bundle with no runtime
 * dependency on any external knowledge base or filesystem path.
 *
 * To add a new reference: drop the file under ./assets/references/ and add a
 * matching import + entry below. The action handlers read from this array
 * exclusively.
 */

// --- Main guide ---
import skillMd from './assets/SKILL.md' with { type: 'text' }

// --- Reference documents (canonical order; the tool's `reference` action
// validates against this list, so adding here is what exposes it to the model) ---
import complexAnalysis from './assets/references/complex-analysis.md' with { type: 'text' }
import measureIntegration from './assets/references/measure-integration.md' with { type: 'text' }
import functionalAnalysis from './assets/references/functional-analysis.md' with { type: 'text' }
import harmonicFourier from './assets/references/harmonic-fourier.md' with { type: 'text' }
import spectralTheory from './assets/references/spectral-theory.md' with { type: 'text' }
import geometricAnalysis from './assets/references/geometric-analysis.md' with { type: 'text' }
import variationalMethods from './assets/references/variational-methods.md' with { type: 'text' }
import optimalTransport from './assets/references/optimal-transport.md' with { type: 'text' }

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
    name: 'complex-analysis',
    path: 'assets/references/complex-analysis.md',
    content: stripFrontmatter(complexAnalysis),
  },
  {
    name: 'measure-integration',
    path: 'assets/references/measure-integration.md',
    content: stripFrontmatter(measureIntegration),
  },
  {
    name: 'functional-analysis',
    path: 'assets/references/functional-analysis.md',
    content: stripFrontmatter(functionalAnalysis),
  },
  {
    name: 'harmonic-fourier',
    path: 'assets/references/harmonic-fourier.md',
    content: stripFrontmatter(harmonicFourier),
  },
  {
    name: 'spectral-theory',
    path: 'assets/references/spectral-theory.md',
    content: stripFrontmatter(spectralTheory),
  },
  {
    name: 'geometric-analysis',
    path: 'assets/references/geometric-analysis.md',
    content: stripFrontmatter(geometricAnalysis),
  },
  {
    name: 'variational-methods',
    path: 'assets/references/variational-methods.md',
    content: stripFrontmatter(variationalMethods),
  },
  {
    name: 'optimal-transport',
    path: 'assets/references/optimal-transport.md',
    content: stripFrontmatter(optimalTransport),
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
