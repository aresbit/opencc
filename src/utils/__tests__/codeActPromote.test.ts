import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
})
