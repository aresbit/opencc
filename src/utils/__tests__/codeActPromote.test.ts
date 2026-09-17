import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeCodeActCode } from '../codeActSandbox.js'
import { getCodeActRuntimeStatus } from '../codeActLanguageAdapters.js'
import {
  getActionsDir,
  getSkillStoreDir,
  listPromoted,
  promoteRun,
  slugForPromotion,
} from '../codeActPromote.js'

/**
 * The loop this closes: a script that worked was retyped next time, because
 * `~/.claude/action/` — copied into every sandbox as `actions/` on every run —
 * was never mentioned to the model, and there was no way to put a file there
 * short of guessing the path. The mechanism existed and nothing pointed at it.
 *
 * Names are prefixed and removed afterwards; these write to the real store,
 * the way the artifact tests already do, because the paths are the behaviour.
 */
const PREFIX = 'promote-test-'
const created: string[] = []

function uniqueName(suffix: string): string {
  const name = `${PREFIX}${suffix}`
  created.push(name)
  return name
}

afterEach(() => {
  for (const name of created.splice(0)) {
    rmSync(join(getActionsDir(), name), { recursive: true, force: true })
    rmSync(join(getSkillStoreDir(), name), { recursive: true, force: true })
  }
})

function sourceFile(contents: string, basename = 'agent.js'): string {
  const dir = mkdtempSync(join(tmpdir(), 'promote-src-'))
  const path = join(dir, basename)
  writeFileSync(path, contents)
  return path
}

describe('slugForPromotion', () => {
  test('normalises to what the skill loader can actually load', () => {
    // The store is scanned one level deep and the directory name becomes the
    // skill name, so anything else either fails to load or loads under a name
    // nobody can type.
    expect(slugForPromotion('CSV Summary')).toBe('csv-summary')
    expect(slugForPromotion('  Parse__Logs!! ')).toBe('parse-logs')
  })

  test('refuses a name with nothing usable in it', () => {
    expect(() => slugForPromotion('!!!')).toThrow()
  })
})

describe('promoteRun', () => {
  test('writes the script where future runs look for it', async () => {
    const name = uniqueName('basic')
    const src = sourceFile('export const answer = 42\n')

    const result = await promoteRun({
      name,
      description: 'Returns the answer.',
      sourcePath: src,
      language: 'javascript',
    })

    expect(existsSync(result.actionPath)).toBe(true)
    expect(result.actionPath).toBe(join(getActionsDir(), name, 'agent.js'))
    expect(readFileSync(result.actionPath, 'utf8')).toContain('answer = 42')
  })

  test('registers a SKILL.md the loader can parse', async () => {
    const name = uniqueName('skillmd')
    const src = sourceFile('console.log(1)\n')

    const result = await promoteRun({
      name,
      description: 'Prints one.',
      sourcePath: src,
      language: 'javascript',
    })

    const skill = readFileSync(join(result.skillPath, 'SKILL.md'), 'utf8')
    // Frontmatter is what makes it discoverable at startup; without it the
    // file is just a document sitting in the store.
    expect(skill).toMatch(/^---\nname: /)
    expect(skill).toContain(`name: ${name}`)
    expect(skill).toContain('Prints one.')
    // And it has to say how to reach the script from inside a run, which is
    // the fact that was missing everywhere before.
    expect(skill).toContain(`actions/${name}/agent.js`)
  })

  test('inlines a short script and points at a long one', async () => {
    const short = uniqueName('short')
    const long = uniqueName('long')

    const shortResult = await promoteRun({
      name: short,
      description: 'Short.',
      sourcePath: sourceFile('const x = 1\n'),
      language: 'javascript',
    })
    expect(
      readFileSync(join(shortResult.skillPath, 'SKILL.md'), 'utf8'),
    ).toContain('const x = 1')

    const longResult = await promoteRun({
      name: long,
      description: 'Long.',
      sourcePath: sourceFile(`// ${'x'.repeat(9000)}\n`),
      language: 'javascript',
    })
    const longSkill = readFileSync(join(longResult.skillPath, 'SKILL.md'), 'utf8')
    expect(longSkill).not.toContain('x'.repeat(9000))
    expect(longSkill).toContain('Too long to inline')
  })

  test('mentions the sandbox when the script needs one', async () => {
    const name = uniqueName('sandbox')
    const result = await promoteRun({
      name,
      description: 'Needs deps.',
      sourcePath: sourceFile('import numpy\n', 'agent.py'),
      language: 'python',
      persistKey: 'ml-env',
    })

    const skill = readFileSync(join(result.skillPath, 'SKILL.md'), 'utf8')
    // Installed dependencies live in the sandbox, not in actions/ — a promoted
    // script that needs them is useless without being told which one.
    expect(skill).toContain('persistKey: "ml-env"')
  })

  test('promoting the same name again replaces it', async () => {
    const name = uniqueName('replace')

    await promoteRun({
      name,
      description: 'First.',
      sourcePath: sourceFile('const v = 1\n'),
      language: 'javascript',
    })
    const second = await promoteRun({
      name,
      description: 'Second.',
      sourcePath: sourceFile('const v = 2\n'),
      language: 'javascript',
    })

    // A script is promoted after it works, and the second version is usually
    // the one worth keeping; refusing would make improving a promoted script
    // harder than promoting it in the first place.
    expect(readFileSync(second.actionPath, 'utf8')).toContain('const v = 2')
    expect(
      readFileSync(join(second.skillPath, 'SKILL.md'), 'utf8'),
    ).toContain('Second.')
  })

  test('shows up in the promoted listing', async () => {
    const name = uniqueName('listed')
    await promoteRun({
      name,
      description: 'Findable.',
      sourcePath: sourceFile('const a = 1\n'),
      language: 'javascript',
    })

    const listed = await listPromoted()
    const mine = listed.find(entry => entry.name === name)
    expect(mine).toBeDefined()
    expect(mine!.description).toBe('Findable.')
  })

  test('re-promoting in another language replaces rather than accumulates', async () => {
    const name = uniqueName('langswap')

    await promoteRun({
      name,
      description: 'Python version.',
      sourcePath: sourceFile('def twice(n): return n * 2\n', 'agent.py'),
      language: 'python',
    })
    await promoteRun({
      name,
      description: 'Rust version.',
      sourcePath: sourceFile('pub fn twice(n: i32) -> i32 { n * 2 }\n', 'agent.rs'),
      language: 'rust',
    })

    // A different language means a different basename, so a plain copy left
    // the old file behind: nothing referenced it, the SKILL.md described the
    // new one, and nothing would ever clean it up.
    const files = readdirSync(join(getActionsDir(), name))
    expect(files).toEqual(['agent.rs'])
  })

  test('the SKILL.md shows how to reach it in that language', async () => {
    const rust = uniqueName('rustsnip')
    const rustResult = await promoteRun({
      name: rust,
      description: 'Rust.',
      sourcePath: sourceFile('pub fn f() {}\n', 'agent.rs'),
      language: 'rust',
    })
    // rustc compiles a single file, so reuse needs a #[path] attribute. No
    // model guesses that from "import it"; verified working before shipping.
    expect(readFileSync(join(rustResult.skillPath, 'SKILL.md'), 'utf8')).toContain(
      `#[path = "actions/${rust}/agent.rs"]`,
    )

    const py = uniqueName('pysnip')
    const pyResult = await promoteRun({
      name: py,
      description: 'Python.',
      sourcePath: sourceFile('def f(): pass\n', 'agent.py'),
      language: 'python',
    })
    // actions/ is not a package, so the directory has to go on sys.path.
    expect(readFileSync(join(pyResult.skillPath, 'SKILL.md'), 'utf8')).toContain(
      `sys.path.insert(0, 'actions/${py}')`,
    )
  })

  test('OCaml promotion is named for its module, not agent.ml', async () => {
    const name = uniqueName('ocaml')
    const result = await promoteRun({
      name,
      description: 'OCaml.',
      sourcePath: sourceFile('let twice n = n * 2\n', 'agent.ml'),
      language: 'ocaml',
    })

    // A module's name IS its filename capitalised, so leaving every promoted
    // OCaml script as agent.ml would make them all module `Agent` — colliding
    // with each other and with the agent source of whatever imports them.
    // Hyphens are illegal in a module name, hence the underscores.
    const expected = `${name.replace(/-/g, '_')}.ml`
    expect(result.actionPath.endsWith(expected)).toBe(true)

    const skill = readFileSync(join(result.skillPath, 'SKILL.md'), 'utf8')
    const moduleName = expected.replace(/\.ml$/, '').replace(/^./, c => c.toUpperCase())
    expect(skill).toContain(moduleName)
  })
})

/**
 * OCaml linking, end to end.
 *
 * Gated on the runtime, like the OCaml cases in codeActSandbox.test.ts: these
 * compile for real, and a machine without ocamlopt/ocamlc should skip rather
 * than fail. They were run against OCaml 4.14.1 before shipping.
 */
const ocamlRuntime = getCodeActRuntimeStatus('ocaml')
if (ocamlRuntime.available) {
  describe('promoted OCaml modules link', () => {
    test('a later run can call into a promoted module', async () => {
      const name = uniqueName('ocamllink')
      await promoteRun({
        name,
        description: 'Doubles.',
        sourcePath: sourceFile('let twice n = n * 2\n', 'agent.ml'),
        language: 'ocaml',
      })

      const moduleName = `${name.replace(/-/g, '_')}`.replace(/^./, c =>
        c.toUpperCase(),
      )
      const result = await executeCodeActCode(
        `let () = Printf.printf "%d" (${moduleName}.twice 21)\n`,
        { language: 'ocaml', timeoutMs: 180_000 },
      )

      // compileOcaml built a fixed two-unit list before this, so a promoted
      // .ml could be read but never linked — OCaml was the one language where
      // promotion bought nothing.
      expect(result).toMatchObject({ success: true, stdout: '42' })
    })

    test('a broken promotion does not break unrelated runs', async () => {
      const name = uniqueName('ocamlbroken')
      await promoteRun({
        name,
        description: 'Broken.',
        sourcePath: sourceFile('let x = this is not ocaml\n', 'agent.ml'),
        language: 'ocaml',
      })

      // OCaml compiles its unit list as a whole, so compiling every promoted
      // module unconditionally would let one bad file fail every OCaml run in
      // the system. Units are selected by reference for exactly this reason.
      const result = await executeCodeActCode(
        'let () = print_string "fine"\n',
        { language: 'ocaml', timeoutMs: 180_000 },
      )
      expect(result).toMatchObject({ success: true, stdout: 'fine' })
    })
  })
}
