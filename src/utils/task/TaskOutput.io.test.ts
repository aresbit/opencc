import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdir, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { TaskOutput } from './TaskOutput.js'

const outputs: TaskOutput[] = []

afterEach(async () => {
  await Promise.all(
    outputs.splice(0).map(async output => {
      output.clear()
      await unlink(output.path).catch(() => {})
    }),
  )
})

async function createFileOutput(content: string): Promise<TaskOutput> {
  const output = new TaskOutput(`io-test-${crypto.randomUUID()}`, null, true)
  outputs.push(output)
  await mkdir(dirname(output.path), { recursive: true })
  await writeFile(output.path, content)
  return output
}

describe('TaskOutput file observations', () => {
  test('coalesces concurrent exact size probes', async () => {
    const output = await createFileOutput('abcdef')
    const [first, second] = await Promise.all([
      output.getFileSize(-1),
      output.getFileSize(-1),
    ])
    expect(first).toBe(6)
    expect(second).toBe(6)
  })

  test('reuses recent observations and supports forced refresh', async () => {
    const output = await createFileOutput('abcdef')
    expect(await output.getFileSize(-1)).toBe(6)
    await appendFile(output.path, 'ghi')
    expect(await output.getFileSize()).toBe(6)
    expect(await output.getFileSize(-1)).toBe(9)

    expect(await output.readFileTail(4, -1)).toBe('fghi')
    await appendFile(output.path, 'j')
    expect(await output.readFileTail(4)).toBe('fghi')
    expect(await output.readFileTail(4, -1)).toBe('ghij')
  })
})
