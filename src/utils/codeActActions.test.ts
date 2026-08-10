import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeActionDef } from './executeAction.js'
import { loadActionsFromDir } from './loadActionsDir.js'
import { getCodeActRuntimeStatus } from './codeActLanguageAdapters.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path =>
    rm(path, { recursive: true, force: true }),
  ))
})

describe('CodeAct Action language lifecycle', () => {
  test('discovers Rust, OCaml, and Scheme actions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeact-actions-'))
    cleanup.push(directory)
    await Promise.all([
      writeFile(join(directory, 'safe.rs'), 'fn main() {}'),
      writeFile(join(directory, 'effects.ml'), 'let () = ()'),
      writeFile(join(directory, 'continuation.scm'), '(display 1)'),
    ])

    const actions = await loadActionsFromDir(directory)
    expect(actions.map(action => action.language).sort()).toEqual([
      'ocaml', 'rust', 'scheme',
    ])
  })

  if (getCodeActRuntimeStatus('rust').available) {
    test('passes Action arguments to a compiled Rust action', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'codeact-actions-'))
      cleanup.push(directory)
      const filePath = join(directory, 'args.rs')
      await writeFile(filePath, `---
name: rust-args
description: print Action arguments
language: rust
---
fn main() {
    println!("{}", std::env::var("ACTION_ARGS").unwrap());
}`)

      const result = await executeActionDef({
        name: 'rust-args',
        description: 'print Action arguments',
        language: 'rust',
        filePath,
      }, { control: 'result' })

      expect(result).toMatchObject({
        success: true,
        stdout: '{"control":"result"}',
        exitCode: 0,
      })
    })
  }
})
