/**
 * Bundled asset registry for the AlgebraMasterTool (代数大师).
 *
 * Every file under ./assets/ is imported as inline text via Bun's
 * `with { type: 'text' }` import attribute. At build time the bundler
 * inlines each file's contents as a string constant, so the tool carries
 * its own knowledge base inside the single-file bundle with no runtime
 * dependency on any external path.
 *
 * The content is self-contained: every reference is a faithful copy of the
 * relevant mathematics (group/Galois theory, commutative algebra, Lie algebras
 * and root systems, representation theory, homological algebra, category theory
 * and universal properties, and the geometry/topology/K-theory interface). Each
 * reference file records its textbook/course attribution at the top so
 * provenance survives bundling, without pointing at any external path.
 *
 * To add a new reference: drop the file under ./assets/references/ and add a
 * matching import + entry below. The AlgebraMasterTool.ts action handlers read
 * from these arrays exclusively.
 */

// --- Main guide ---
import skillMd from './assets/SKILL.md' with { type: 'text' }

// --- Reference documents (canonical order; the tool's `reference` action
// validates against this list, so adding here is what exposes it to the model) ---
import groupTheoryGalois from './assets/references/group-theory-galois.md' with { type: 'text' }
import commutativeAlgebra from './assets/references/commutative-algebra.md' with { type: 'text' }
import lieAlgebraRootSystems from './assets/references/lie-algebra-root-systems.md' with { type: 'text' }
import representationTheory from './assets/references/representation-theory.md' with { type: 'text' }
import homologicalAlgebra from './assets/references/homological-algebra.md' with { type: 'text' }
import categoryUniversalProperties from './assets/references/category-universal-properties.md' with { type: 'text' }
import algebraicGeometryTopologyK from './assets/references/algebraic-geometry-topology-k.md' with { type: 'text' }

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
    name: 'group-theory-galois',
    path: 'assets/references/group-theory-galois.md',
    content: stripFrontmatter(groupTheoryGalois),
  },
  {
    name: 'commutative-algebra',
    path: 'assets/references/commutative-algebra.md',
    content: stripFrontmatter(commutativeAlgebra),
  },
  {
    name: 'lie-algebra-root-systems',
    path: 'assets/references/lie-algebra-root-systems.md',
    content: stripFrontmatter(lieAlgebraRootSystems),
  },
  {
    name: 'representation-theory',
    path: 'assets/references/representation-theory.md',
    content: stripFrontmatter(representationTheory),
  },
  {
    name: 'homological-algebra',
    path: 'assets/references/homological-algebra.md',
    content: stripFrontmatter(homologicalAlgebra),
  },
  {
    name: 'category-universal-properties',
    path: 'assets/references/category-universal-properties.md',
    content: stripFrontmatter(categoryUniversalProperties),
  },
  {
    name: 'algebraic-geometry-topology-k',
    path: 'assets/references/algebraic-geometry-topology-k.md',
    content: stripFrontmatter(algebraicGeometryTopologyK),
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
