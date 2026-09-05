/**
 * Write Guard — lint before disk.
 *
 * Intercepts Write and Edit tool calls. For JS/TS/TSX/JSX files,
 * performs quick structural checks before allowing the write. If
 * issues are found, returns a deny result so the model fixes first.
 */

import type { OnRegistrar } from '../types.js'

const GUARDED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs',
])

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  return dot >= 0 ? filePath.slice(dot) : ''
}

interface LintIssue {
  line: number
  message: string
}

function quickLint(content: string, filePath: string): LintIssue[] {
  const issues: LintIssue[] = []
  const lines = content.split('\n')

  let braces = 0
  let brackets = 0
  let parens = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip comments (rough heuristic)
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue
    }

    // Count delimiters (outside strings — simplified)
    for (const ch of line) {
      switch (ch) {
        case '{': braces++; break
        case '}': braces--; break
        case '[': brackets++; break
        case ']': brackets--; break
        case '(': parens++; break
        case ')': parens--; break
      }
    }

    // Detect leftover debugger statements
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      issues.push({ line: lineNum, message: 'debugger statement left in code' })
    }

    // Detect console.log in non-test files
    if (
      /console\.(log|debug|info)\(/.test(line) &&
      !filePath.includes('.test.') &&
      !filePath.includes('__tests__') &&
      !filePath.includes('/test/')
    ) {
      issues.push({ line: lineNum, message: 'console.log in non-test file' })
    }
  }

  if (braces !== 0) {
    issues.push({
      line: lines.length,
      message: `Unbalanced braces: ${braces > 0 ? `${braces} unclosed '{'` : `${-braces} extra '}'`}`,
    })
  }
  if (brackets !== 0) {
    issues.push({
      line: lines.length,
      message: `Unbalanced brackets: ${brackets > 0 ? `${brackets} unclosed '['` : `${-brackets} extra ']'`}`,
    })
  }
  if (parens !== 0) {
    issues.push({
      line: lines.length,
      message: `Unbalanced parentheses: ${parens > 0 ? `${parens} unclosed '('` : `${-parens} extra ')'`}`,
    })
  }

  return issues
}

export function register(on: OnRegistrar): void {
  on('tool.call', { tool_name: 'Write' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    const content = e.tool_input?.content as string

    if (!filePath || !content) return next(e)
    if (!GUARDED_EXTENSIONS.has(getExtension(filePath))) return next(e)

    const issues = quickLint(content, filePath)
    if (issues.length > 0) {
      const report = issues
        .map(i => `  L${i.line}: ${i.message}`)
        .join('\n')
      return { deny: `Fix before writing to ${filePath}:\n${report}` }
    }

    return next(e)
  })

  on('tool.call', { tool_name: 'Edit' }, async ($, e: any, next) => {
    const filePath = e.tool_input?.file_path as string
    const newString = e.tool_input?.new_string as string

    if (!filePath || !newString) return next(e)
    if (!GUARDED_EXTENSIONS.has(getExtension(filePath))) return next(e)

    // For Edit, only check the new_string fragment for debugger/console
    const lines = newString.split('\n')
    const issues: LintIssue[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      if (/^\s*debugger\s*;?\s*$/.test(line)) {
        issues.push({ line: lineNum, message: 'debugger statement in edit' })
      }
    }

    if (issues.length > 0) {
      const report = issues
        .map(i => `  L${i.line}: ${i.message}`)
        .join('\n')
      return { deny: `Fix before editing ${filePath}:\n${report}` }
    }

    return next(e)
  })
}
