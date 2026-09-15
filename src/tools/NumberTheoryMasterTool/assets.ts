/**
 * Bundled asset registry for the NumberTheoryMasterTool (数论大师).
 *
 * Every file under ./assets/ is imported as inline text via Bun's
 * `with { type: 'text' }` import attribute. At build time the bundler
 * inlines each file's contents as a string constant, so the tool carries
 * its own number-theory documentation inside the single-file bundle with
 * no runtime dependency on any external knowledge base or path.
 *
 * The mathematical content was condensed from three Chinese course
 * digests (Shoup's *A Computational Introduction to Number Theory and
 * Algebra*, Marcus's *Number Fields*, and Quine's *Lectures on Analytic
 * Number Theory*) and is reproduced in full inside ./assets/references/,
 * with per-file "整理自 <textbook/course>" attribution. No file-system
 * paths appear in the returned documents.
 *
 * To add a reference: drop the .md file under ./assets/references/ and add
 * a matching import + entry below. NumberTheoryMasterTool.ts reads from
 * the REFERENCES array exclusively.
 */

// --- Main guide ---
import skillMd from './assets/SKILL.md' with { type: 'text' }

// --- Reference documents (canonical order; the tool's `reference` action
// validates against this list, so adding here is what exposes it to the model) ---
import elementaryCongruence from './assets/references/elementary-congruence.md' with { type: 'text' }
import euclidRsa from './assets/references/euclid-rsa.md' with { type: 'text' }
import primalityTesting from './assets/references/primality-testing.md' with { type: 'text' }
import discreteLogFactoring from './assets/references/discrete-log-factoring.md' with { type: 'text' }
import quadraticResidues from './assets/references/quadratic-residues.md' with { type: 'text' }
import finiteFields from './assets/references/finite-fields.md' with { type: 'text' }
import algebraicNumberTheory from './assets/references/algebraic-number-theory.md' with { type: 'text' }
import analyticNumberTheory from './assets/references/analytic-number-theory.md' with { type: 'text' }

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
    name: 'elementary-congruence',
    path: 'assets/references/elementary-congruence.md',
    content: stripFrontmatter(elementaryCongruence),
  },
  {
    name: 'euclid-rsa',
    path: 'assets/references/euclid-rsa.md',
    content: stripFrontmatter(euclidRsa),
  },
  {
    name: 'primality-testing',
    path: 'assets/references/primality-testing.md',
    content: stripFrontmatter(primalityTesting),
  },
  {
    name: 'discrete-log-factoring',
    path: 'assets/references/discrete-log-factoring.md',
    content: stripFrontmatter(discreteLogFactoring),
  },
  {
    name: 'quadratic-residues',
    path: 'assets/references/quadratic-residues.md',
    content: stripFrontmatter(quadraticResidues),
  },
  {
    name: 'finite-fields',
    path: 'assets/references/finite-fields.md',
    content: stripFrontmatter(finiteFields),
  },
  {
    name: 'algebraic-number-theory',
    path: 'assets/references/algebraic-number-theory.md',
    content: stripFrontmatter(algebraicNumberTheory),
  },
  {
    name: 'analytic-number-theory',
    path: 'assets/references/analytic-number-theory.md',
    content: stripFrontmatter(analyticNumberTheory),
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
