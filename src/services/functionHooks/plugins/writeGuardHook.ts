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

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('__tests__') ||
    filePath.includes('/test/')
  )
}

/**
 * JSX/TSX, where the text between tags is neither code nor a string.
 *
 * Delimiter balancing is skipped for these files. The text inside a JSX element
 * is literal — `https://example.com` carries a `//` that a code scanner reads
 * as a comment and swallows the rest of the line with, and an apostrophe in
 * "don't" opens a string that never closes. Getting this right needs a real
 * JSX parser; every half-measure tried here moved the false positives around
 * rather than removing them (one version denied 147 files in this repo for
 * reading `</Tag>` as a regex). Structure checks stay on, because a stray
 * `debugger` or `console.log` is still worth catching; it is the brace count
 * that cannot be answered without knowing whether the characters are code.
 */
function isJsx(filePath: string): boolean {
  const ext = getExtension(filePath)
  return ext === '.tsx' || ext === '.jsx'
}

interface LintIssue {
  line: number
  message: string
}

/** Characters that end an expression, so a `/` after them is division. */
const REGEX_PRECEDING_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
])

/**
 * Whether a `/` at this position opens a regex literal rather than dividing.
 *
 * Character-level guessing cannot answer this. `estimates[i]! / total` and
 * `! /re/.test(x)` differ only in whether the `!` was postfix or prefix, and a
 * rule keyed on the character before the `/` reads the first as a regex and
 * swallows the rest of the line with it — losing a `)` and reporting the file
 * as unbalanced. What decides it is the KIND of the preceding token: a `/`
 * after an operand divides, a `/` after an operator introduces a regex. So the
 * scanner carries that kind, and `!`, `++` and `--` resolve to whichever they
 * are by the token they follow.
 */
function canStartRegex(word: string, lastKind: 'operand' | 'operator'): boolean {
  if (word !== '' && REGEX_PRECEDING_WORDS.has(word)) return true
  return lastKind === 'operator'
}

/**
 * Blank out everything that is not code — string and template literal text,
 * and both comment forms.
 *
 * Counting delimiters over the raw characters is what made this guard deny
 * writes that were fine. `line.startsWith('{')` holds a `{` inside a string
 * literal, and the old check counted it as a code brace that never closed, so
 * a file that was correct came back as `Unbalanced braces: 1 unclosed '{'`.
 * The check has to run on code, so this returns a copy of the source with
 * every non-code character replaced by a space. Positions are preserved, so
 * the per-line checks still report the line the reader would go to.
 *
 * A template literal's text is blanked but its interpolation is not: the stack
 * drops back into code at the `${`, so that expression is counted like any
 * other code. Both the `${` and the `}` that closes it stay in the mask,
 * because that brace's partner is the one the interpolation opened — blanking
 * one and not the other would trade a false negative for a false positive.
 *
 * Regex literals are blanked too, by the same argument; see canStartRegex.
 */
function maskNonCode(content: string): string {
  const n = content.length
  const out = content.split('')
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' '
    }
  }

  interface Frame {
    kind: 'code' | 'template'
    /** Braces opened inside this frame and not yet closed. */
    depth: number
    /** Opened by an interpolation, so its closing brace returns to a template. */
    fromTemplate: boolean
  }
  const stack: Frame[] = [{ kind: 'code', depth: 0, fromTemplate: false }]

  // Whether the last token ended an expression (an operand — identifier,
  // number, literal, closing bracket) or not (an operator or punctuation).
  // This, plus the identifier just read, is how `/` is told apart from division.
  let lastKind: 'operand' | 'operator' = 'operator'
  let word = ''
  let i = 0

  while (i < n) {
    const ch = content[i]
    const frame = stack[stack.length - 1]

    if (frame.kind === 'template') {
      if (ch === '\\') {
        blank(i, i + 2)
        i += 2
        continue
      }
      if (ch === '`') {
        stack.pop()
        i++
        lastKind = 'operand'
        word = ''
        continue
      }
      if (ch === '$' && content[i + 1] === '{') {
        stack.push({ kind: 'code', depth: 0, fromTemplate: true })
        i += 2
        lastKind = 'operator'
        word = ''
        continue
      }
      blank(i, i + 1)
      i++
      continue
    }

    // ── code ────────────────────────────────────────────────────────────
    // Comments blank and change no token: what follows a comment continues the
    // expression the comment interrupted.
    if (ch === '/' && content[i + 1] === '/') {
      const nl = content.indexOf('\n', i)
      const stop = nl < 0 ? n : nl
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const close = content.indexOf('*/', i + 2)
      const stop = close < 0 ? n : close + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < n) {
        if (content[j] === '\\') {
          j += 2
          continue
        }
        // An unterminated quote ends at the newline; carrying the state across
        // lines would blank the rest of the file after one stray apostrophe.
        if (content[j] === '\n') break
        if (content[j] === ch) {
          j++
          break
        }
        j++
      }
      blank(i, j)
      i = j
      lastKind = 'operand'
      word = ''
      continue
    }
    if (ch === '`') {
      blank(i, i + 1)
      stack.push({ kind: 'template', depth: 0, fromTemplate: false })
      i++
      lastKind = 'operand'
      word = ''
      continue
    }
    if (ch === '/') {
      if (canStartRegex(word, lastKind)) {
        let j = i + 1
        let inClass = false
        while (j < n) {
          const c = content[j]
          if (c === '\\') {
            j += 2
            continue
          }
          if (c === '\n') break
          if (c === '[') inClass = true
          else if (c === ']') inClass = false
          else if (c === '/' && !inClass) {
            j++
            break
          }
          j++
        }
        blank(i, j)
        i = j
        lastKind = 'operand'
        word = ''
        continue
      }
      i++
      lastKind = 'operator'
      word = ''
      continue
    }
    if (ch === '{') {
      frame.depth++
      i++
      lastKind = 'operator'
      word = ''
      continue
    }
    if (ch === '}') {
      if (frame.fromTemplate && frame.depth === 0) {
        // Closes a `${`. It stays in the mask to pair with the `{` that opened
        // the interpolation, so nothing is decremented here.
        stack.pop()
      } else {
        frame.depth--
      }
      i++
      lastKind = 'operand'
      word = ''
      continue
    }
    if (ch === '(' || ch === '[') {
      i++
      lastKind = 'operator'
      word = ''
      continue
    }
    if (ch === ')' || ch === ']') {
      i++
      lastKind = 'operand'
      word = ''
      continue
    }
    // A `!` that follows an operand is TypeScript's non-null assertion — it
    // yields a value, so a `/` after it divides. A `!` that follows an operator
    // is negation, and `!/re/` is a regex. The kind therefore does not change.
    if (ch === '!') {
      i++
      word = ''
      continue
    }
    // `i++ / 2` divides; `++i / 2` also divides by way of the operand after it.
    // Only the postfix form has to keep the operand kind here.
    if ((ch === '+' || ch === '-') && content[i + 1] === ch && lastKind === 'operand') {
      i += 2
      word = ''
      continue
    }
    const isWordChar =
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9') ||
      ch === '_' ||
      ch === '$'
    if (isWordChar) {
      word += ch
      lastKind = 'operand'
      i++
      continue
    }
    // Spaces and tabs are not tokens: they change neither `word` nor
    // `lastKind`, which is what keeps `return /re/` readable as a keyword
    // followed by a regex.
    //
    // A newline DOES end the word. Without that, an identifier on the previous
    // line stayed glued to whatever followed — `1` then `return` arrived as
    // `1return`, the keyword lookup missed, and the regex after it was counted
    // as code. That is the whole of gitSafety.ts's false positive.
    if (ch === '\n') {
      word = ''
      i++
      continue
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      lastKind = 'operator'
      word = ''
    }
    i++
  }

  return out.join('')
}

interface DelimiterBalance {
  braces: number
  brackets: number
  parens: number
}

function countDelimiters(masked: string): DelimiterBalance {
  let braces = 0
  let brackets = 0
  let parens = 0
  for (const ch of masked) {
    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
    else if (ch === '(') parens++
    else if (ch === ')') parens--
  }
  return { braces, brackets, parens }
}

function describe(count: number, open: string, close: string): string {
  if (count > 0) return `${count} unclosed '${open}'`
  return `${-count} extra '${close}'`
}

function quickLint(content: string, filePath: string): LintIssue[] {
  const issues: LintIssue[] = []
  const masked = maskNonCode(content)
  const lines = masked.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      issues.push({ line: lineNum, message: 'debugger statement left in code' })
    }

    if (/console\.(log|debug|info)\(/.test(line) && !isTestFile(filePath)) {
      issues.push({ line: lineNum, message: 'console.log in non-test file' })
    }
  }

  // See isJsx: JSX text is not code, so a count taken over it is not a fact
  // about the file. On the .ts/.js side the count is exact.
  if (isJsx(filePath)) return issues

  const balance = countDelimiters(masked)
  if (balance.braces !== 0) {
    issues.push({
      line: lines.length,
      message: `Unbalanced braces: ${describe(balance.braces, '{', '}')}`,
    })
  }
  if (balance.brackets !== 0) {
    issues.push({
      line: lines.length,
      message: `Unbalanced brackets: ${describe(balance.brackets, '[', ']')}`,
    })
  }
  if (balance.parens !== 0) {
    issues.push({
      line: lines.length,
      message: `Unbalanced parentheses: ${describe(balance.parens, '(', ')')}`,
    })
  }

  return issues
}

/** Test seam: the scanner and the check, so both can be driven directly. */
export const __testing = { quickLint, maskNonCode }

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
