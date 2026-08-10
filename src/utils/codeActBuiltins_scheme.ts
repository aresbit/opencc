/** CodeAct Scheme helper library generator (R7RS core, Guile runtime). */

import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { getCodeActBaseDir } from './codeActBuiltins.js'

const VERSION = '1'

function source(): string {
  return `(define (codeact-workspace)
  (or (getenv "CODEACT_WORKSPACE") (getcwd)))

(define (read-file path)
  (call-with-input-file path
    (lambda (port)
      (let loop ((chars '()))
        (let ((char (read-char port)))
          (if (eof-object? char)
              (list->string (reverse chars))
              (loop (cons char chars))))))))

(define (write-file path content)
  (call-with-output-file path
    (lambda (port) (display content port))))

;; Proper-tail-recursive trampoline. A thunk means "continue"; any other
;; value is the final result.
(define (trampoline step)
  (let loop ((current step))
    (if (procedure? current)
        (loop (current))
        current)))

(define (fold-left f initial xs)
  (let loop ((acc initial) (rest xs))
    (if (null? rest)
        acc
        (loop (f acc (car rest)) (cdr rest)))))
`
}

export function ensureCodeActBuiltinsSchemeSync(): string {
  const dir = join(getCodeActBaseDir(), 'builtins_scheme')
  mkdirSync(dir, { recursive: true })
  const versionPath = join(dir, '.version')
  const stale = !existsSync(join(dir, 'codeact.scm')) ||
    !existsSync(versionPath) ||
    readFileSync(versionPath, 'utf-8').trim() !== VERSION
  if (stale) {
    writeFileSync(join(dir, 'codeact.scm'), source(), 'utf-8')
    writeFileSync(versionPath, VERSION, 'utf-8')
  }
  return dir
}
