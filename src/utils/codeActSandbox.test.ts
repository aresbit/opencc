import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import { executeCodeActCode } from './codeActSandbox.js'
import { getCodeActPrompt } from '../tools/CodeActTool/prompt.js'
import {
  CODEACT_LANGUAGES,
  getCodeActLanguageAdapter,
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
      if (status.command) {
        expect(isAbsolute(status.command)).toBe(true)
        expect(status.source).toMatch(/^(path|host|opam)$/)
      }
    }
  })

  test('finds the active opam compiler even when its bin directory is absent from PATH', () => {
    // Guarded rather than assumed: this asserts a fact about the *host*, and
    // asserting it unconditionally makes the whole suite red on any machine
    // without OCaml installed — which is most of them. With opam present the
    // discovery claim is checked as before; without it, the claim under test is
    // that an absent toolchain is reported as absent with a usable hint, not
    // that it is silently reported as something else.
    const hasOpam = existsSync(join(homedir(), '.opam'))
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/usr/bin:/bin'
      const status = getCodeActRuntimeStatus('ocaml')
      if (hasOpam) {
        expect(status).toMatchObject({ available: true, source: 'opam' })
        expect(status.command).toEndWith('/ocamlopt')
      } else {
        expect(status.available).toBe(false)
        expect(status.installHint).toBeTruthy()
      }
    } finally {
      process.env.PATH = originalPath
    }
  })

  test('prefers Chez Scheme while preserving Guile invocation compatibility', () => {
    const adapter = getCodeActLanguageAdapter('scheme')
    expect(adapter.runtimeCandidates).toEqual(['chezscheme', 'scheme', 'guile'])
    expect(
      adapter.interpreterArgs?.('/tmp/agent.scm', '/usr/bin/chezscheme'),
    ).toEqual(['--script', '/tmp/agent.scm'])
    expect(
      adapter.interpreterArgs?.('/tmp/agent.scm', '/usr/bin/guile'),
    ).toEqual(['--no-auto-compile', '-s', '/tmp/agent.scm'])
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
      'discriminated unions',
      'match/case',
      'std::expected',
      'ranges::views',
      'scope_exit',
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

  test('runs TypeScript Result, lazy iterables, bracket, and a trampoline', async () => {
    const result = await executeCodeActCode(
      `import { ok, flatMapResult, filterIterable, fold, call, done, trampoline, bracket, type Bounce } from './builtins/functional.js'

const countdown = (n: number): Bounce<string> =>
  n === 0 ? done('done') : call(() => countdown(n - 1))
const answer = flatMapResult(ok(21), n => ok(n * 2))
const total = fold(filterIterable([1, 2, 3, 4], n => n % 2 === 0), 0, (a, n) => a + n)
const events: string[] = []
const scoped = await bracket(
  () => ({ value: 'resource' }),
  resource => { events.push('use'); return resource.value },
  () => { events.push('release') },
)
console.log(answer.ok ? answer.value : answer.error, total, trampoline(countdown(10_000)), scoped, events.join(','))`,
      { language: 'typescript' },
    )
    expect(result).toMatchObject({
      success: true,
      stdout: '42 6 done resource use,release',
      exitCode: 0,
    })
  })

  test('runs Python Result matching, lazy iterators, bracket, and a trampoline', async () => {
    const result = await executeCodeActCode(
      `from builtins_py.functional import Ok, Err, bind_result, filter_iter, fold, Call, Done, trampoline, bracket

def countdown(n):
    return Done('done') if n == 0 else Call(lambda: countdown(n - 1))

answer = bind_result(Ok(21), lambda n: Ok(n * 2))
total = fold(filter_iter(range(1, 5), lambda n: n % 2 == 0), 0, lambda a, n: a + n)
events = []
scoped = bracket(
    lambda: {'value': 'resource'},
    lambda resource: (events.append('use'), resource['value'])[1],
    lambda _resource: events.append('release'),
)
match answer:
    case Ok(value): print(value, total, trampoline(countdown(10_000)), scoped, ','.join(events))
    case Err(error): raise error`,
      { language: 'python' },
    )
    expect(result).toMatchObject({
      success: true,
      stdout: '42 6 done resource use,release',
      exitCode: 0,
    })
  })

  test('runs modern C++23 ranges, expected, variant, RAII, and a trampoline', async () => {
    const result = await executeCodeActCode(
      `#include "builtins_c/functional.hpp"
#include <functional>
#include <ranges>
#include <string>

int main() {
  auto values = std::views::iota(1, 11)
      | std::views::filter([](int n) { return n % 2 == 0; })
      | std::views::transform([](int n) { return n * n; });
  codeact::Result<int> total = codeact::fold(values, 0, std::plus<>{});

  std::variant<int, std::string> state = 7;
  auto visited = std::visit(codeact::overloaded{
    [](int value) { return value; },
    [](const std::string& value) { return static_cast<int>(value.size()); },
  }, state);

  bool released = false;
  { codeact::scope_exit release([&] { released = true; }); }

  using Bounce = codeact::Bounce<std::string>;
  std::function<Bounce(int)> countdown;
  countdown = [&](int n) -> Bounce {
    if (n == 0) return Bounce::done("done");
    return Bounce::call([&, n] { return countdown(n - 1); });
  };

  if (!total) return 1;
  std::cout << *total << ' ' << visited << ' ' << std::boolalpha << released
            << ' ' << codeact::trampoline(countdown(10'000)) << '\\n';
}`,
      { language: 'cpp' },
    )
    expect(result).toMatchObject({
      success: true,
      stdout: '220 7 true done',
      exitCode: 0,
    })
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
    effc = fun (type a) (eff : a Effect.t) ->
      match eff with
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
