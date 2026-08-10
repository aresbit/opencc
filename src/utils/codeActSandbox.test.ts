import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { executeCodeActCode } from './codeActSandbox.js'
import { getCodeActPrompt } from '../tools/CodeActTool/prompt.js'
import {
  CODEACT_LANGUAGES,
  getCodeActRuntimeStatus,
} from './codeActLanguageAdapters.js'

describe('CodeAct language adapters', () => {
  test('publishes the complete language set and actionable runtime status', () => {
    expect(CODEACT_LANGUAGES).toEqual([
      'typescript', 'python', 'bash', 'c', 'cpp', 'rust', 'ocaml', 'scheme',
    ])

    for (const language of CODEACT_LANGUAGES) {
      const status = getCodeActRuntimeStatus(language)
      expect(status.language).toBe(language)
      expect(status.available ? status.command : status.installHint).toBeTruthy()
    }
  })

  test('teaches control semantics instead of only listing syntax', () => {
    const prompt = getCodeActPrompt(CODEACT_LANGUAGES.map(getCodeActRuntimeStatus))
    for (const concept of [
      'Result<T,E>',
      'Effect.Deep.try_with',
      'one-shot',
      'call/cc',
      'dynamic-wind',
      'string/stream Lisp',
      'trampoline',
    ]) {
      expect(prompt).toContain(concept)
    }
  })

  test('rejects persistKey path traversal before touching a sandbox', async () => {
    const result = await executeCodeActCode('console.log("never")', {
      persistKey: '../../escape',
    })
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('persistKey')
  })

  test('honours an already-aborted execution without leaking the child', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await executeCodeActCode('sleep 30', {
      language: 'bash',
      signal: controller.signal,
    })
    expect(result.success).toBe(false)
    expect(result.stderr).toContain('[ABORTED]')
  })

  test('preserves the existing TypeScript adapter', async () => {
    const result = await executeCodeActCode(
      'console.log([1, 2, 3, 4].filter(n => n % 2 === 0).reduce((a, b) => a + b, 0))',
      { language: 'typescript' },
    )
    expect(result).toMatchObject({ success: true, stdout: '6', exitCode: 0 })
  })

  test('preserves Python, C, and C++ adapters', async () => {
    const cases = [
      {
        language: 'python' as const,
        code: 'print(sum(n for n in range(1, 6)))',
        stdout: '15',
      },
      {
        language: 'c' as const,
        code: 'int main(void) { printf("%d\\n", 3 * 7); return 0; }',
        stdout: '21',
      },
      {
        language: 'cpp' as const,
        code: 'int main() { std::cout << (6 * 7) << "\\n"; }',
        stdout: '42',
      },
    ]

    for (const item of cases) {
      if (!getCodeActRuntimeStatus(item.language).available) continue
      const result = await executeCodeActCode(item.code, { language: item.language })
      expect(result).toMatchObject({ success: true, stdout: item.stdout, exitCode: 0 })
    }
  })

  test('runs Rust 2024 Result, iterators, and an explicit control state machine', async () => {
    const result = await executeCodeActCode(
      `enum Step { More { n: u64, acc: u64 }, Done(u64) }
fn factorial(n: u64) -> u64 {
  let mut state = Step::More { n, acc: 1 };
  loop {
    state = match state {
      Step::More { n: 0, acc } => Step::Done(acc),
      Step::More { n, acc } => Step::More { n: n - 1, acc: acc * n },
      Step::Done(value) => break value,
    };
  }
}
fn total() -> Result<i64, &'static str> {
  Ok((1..=10).filter(|n| n % 2 == 0).sum())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
  println!("{} {}", total()?, factorial(10));
  Ok(())
}`,
      { language: 'rust' },
    )
    expect(result).toMatchObject({
      success: true,
      stdout: '30 3628800',
      exitCode: 0,
    })
  })

  test('runs functional Bash streams and a stack-safe trampoline', async () => {
    const result = await executeCodeActCode(
      `sum() { printf '%s\\n' "$(( $1 + $2 ))"; }
countdown() {
  local n="$1"
  if (( n == 0 )); then printf 'done\\n'; return; fi
  continue_with countdown "$(( n - 1 ))"
}
printf '1\\n2\\n3\\n4\\n' | fold_lines sum 0
trampoline countdown 10000
run_cmd printf '%s\\n' 'argument with spaces'`,
      { language: 'bash' },
    )
    expect(result).toMatchObject({
      success: true,
      stdout: '10\ndone\nargument with spaces',
      exitCode: 0,
    })
  })

  const ocaml = getCodeActRuntimeStatus('ocaml')
  if (ocaml.available) {
    test('runs tail-recursive OCaml code', async () => {
      const result = await executeCodeActCode(
        `let rec fold_left f acc = function
  | [] -> acc
  | x :: xs -> fold_left f (f acc x) xs
let () = Printf.printf "%d\\n" (fold_left ( + ) 0 [1; 2; 3; 4])`,
        { language: 'ocaml' },
      )
      expect(result).toMatchObject({ success: true, stdout: '10', exitCode: 0 })
    })

    const version = spawnSync(ocaml.command!, ['-version'], { encoding: 'utf-8' })
      .stdout.trim()
    if (Number(version.split('.')[0]) >= 5) {
      test('runs an OCaml 5 resumable effect handler', async () => {
        const result = await executeCodeActCode(
          `type _ Effect.t += Yield : int -> unit Effect.t
let yielded = ref []
let run producer =
  Effect.Deep.try_with producer () {
    effc = fun (type a) (effect : a Effect.t) ->
      match effect with
      | Yield value -> Some (fun (k : (a, unit) Effect.Deep.continuation) ->
          yielded := value :: !yielded;
          Effect.Deep.continue k ())
      | _ -> None
  }
let () =
  run (fun () -> Effect.perform (Yield 1); Effect.perform (Yield 2));
  List.rev !yielded |> List.iter (Printf.printf "%d ")`,
          { language: 'ocaml' },
        )
        expect(result).toMatchObject({ success: true, stdout: '1 2', exitCode: 0 })
      })
    }
  } else {
    test.skip('runs tail-recursive OCaml code (runtime unavailable)', () => {})
  }

  const scheme = getCodeActRuntimeStatus('scheme')
  if (scheme.available) {
    test('runs Scheme call/cc and proper tail calls', async () => {
      const result = await executeCodeActCode(
        `(define answer
  (call/cc
    (lambda (return)
      (for-each (lambda (n) (if (even? n) (return n))) '(1 3 8 9))
      #f)))
(display answer)
(newline)`,
        { language: 'scheme' },
      )
      expect(result).toMatchObject({ success: true, stdout: '8', exitCode: 0 })
    })
  } else {
    test.skip('runs Scheme call/cc and proper tail calls (runtime unavailable)', () => {})
  }

  const unavailable = [ocaml, scheme].find(status => !status.available)
  if (unavailable) {
    test('reports a missing runtime without spawning or retrying', async () => {
      const result = await executeCodeActCode('ignored', {
        language: unavailable.language,
      })
      expect(result.exitCode).toBe(127)
      expect(result.stderr).toContain(`runtime unavailable for ${unavailable.language}`)
    })
  }
})
