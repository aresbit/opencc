import { mkdir } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

function stateDir(): string {
  return join(getClaudeConfigHomeDir(), 'showme')
}

export async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true })
}

export async function writeArtifact(name: string, content: string): Promise<string> {
  await ensureStateDir()
  const path = join(stateDir(), name)
  await Bun.write(path, content)
  return path
}

export function formatTree(spec: string): string {
  const lines = spec.split('\n').filter(l => l.trim())
  const result: string[] = []
  for (const line of lines) {
    const indent = line.search(/\S/)
    const depth = Math.floor(indent / 2)
    const name = line.trim()
    if (depth === 0) {
      result.push(name)
    } else {
      const prefix = '  '.repeat(depth - 1) + '├── '
      result.push(prefix + name)
    }
  }
  // Fix last sibling at each depth to use └── instead of ├──
  for (let i = result.length - 1; i >= 0; i--) {
    const match = result[i].match(/^(\s*)├/)
    if (match) {
      const prefix = match[1]
      let isLast = true
      for (let j = i + 1; j < result.length; j++) {
        const nextIndent = result[j].search(/\S/)
        if (nextIndent <= prefix.length) {
          break
        }
        if (nextIndent === prefix.length && result[j][prefix.length] === '├') {
          isLast = false
          break
        }
      }
      if (isLast) {
        result[i] = prefix + '└── ' + result[i].slice(prefix.length + 4)
      }
    }
  }
  return result.join('\n')
}

export function formatDiff(before: string, after: string): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const result: string[] = ['--- before', '+++ after']

  // Simple LCS-based unified diff
  const m = beforeLines.length
  const n = afterLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = beforeLines[i - 1] === afterLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const ops: Array<{ type: 'keep' | 'del' | 'add'; line: string }> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      ops.unshift({ type: 'keep', line: beforeLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', line: afterLines[j - 1] })
      j--
    } else {
      ops.unshift({ type: 'del', line: beforeLines[i - 1] })
      i--
    }
  }

  for (const op of ops) {
    if (op.type === 'keep') result.push(` ${op.line}`)
    else if (op.type === 'del') result.push(`-${op.line}`)
    else result.push(`+${op.line}`)
  }
  return result.join('\n')
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    let max = h.length
    for (const row of rows) {
      if (row[i] && row[i].length > max) max = row[i].length
    }
    return max
  })
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
  const headerLine = '| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |'
  const sepLine = '|' + widths.map(w => '-'.repeat(w + 2)).join('|') + '|'
  const dataLines = rows.map(
    row => '| ' + headers.map((_, i) => pad(row[i] ?? '', widths[i])).join(' | ') + ' |',
  )
  return [headerLine, sepLine, ...dataLines].join('\n')
}

export function formatPseudocode(spec: string): string {
  return '```\n' + spec.trim() + '\n```'
}
