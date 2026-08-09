import { mkdir, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { TaskOutput } from '../../src/utils/task/TaskOutput.js'

const mode = process.argv[2] ?? 'shared'
const iterations = Number(process.argv[3] ?? '1000')
const output = new TaskOutput(`syscall-bench-${process.pid}`, null, true)

await mkdir(dirname(output.path), { recursive: true })
await writeFile(output.path, 'benchmark')
try {
  for (let i = 0; i < iterations; i++) {
    if (mode === 'baseline') {
      await Promise.all([stat(output.path), stat(output.path)])
    } else {
      await Promise.all([output.getFileSize(-1), output.getFileSize(-1)])
    }
  }
} finally {
  await output.deleteOutputFile()
  output.clear()
}
