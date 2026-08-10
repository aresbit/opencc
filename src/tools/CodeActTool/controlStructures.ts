/** Language-specific control knowledge kept separate from tool mechanics. */

export const CONTROL_STRUCTURE_GUIDE = `### Control-structure playbook

The default scripting languages are already strong functional hosts:

| Problem | TypeScript | Python | Modern C++23 |
|---------|------------|--------|--------------|
| Recoverable failure | discriminated Result union | Ok/Err dataclasses + match | std::expected |
| Lazy transformation | Iterable + generator | iterator/generator | ranges::views |
| Data/control states | tagged union + exhaustive never | dataclass union + match/case | variant + visit |
| Resource scope | async bracket/finally | context manager/bracket | RAII/scope_exit |
| Stack-safe recursion | explicit Bounce trampoline | explicit Bounce trampoline | Bounce trampoline/state machine |

Use these before reaching for a more exotic runtime: TypeScript is excellent
for typed effectful workflows, Python for lazy dataflow and rapid interpreters,
and C++23 for zero-cost range pipelines plus explicit ownership.

| Problem | Rust | OCaml | Scheme | Bash |
|---------|------|-------|--------|------|
| Recoverable failure | Result<T,E> and ? | result/option + match | tagged value or handler | exit status + stderr |
| Lazy transformation | Iterator | Seq | delayed stream | pipeline |
| Resource scope | RAII/Drop | protect/finally | dynamic-wind | with_* / trap |
| Suspend/resume | Future or enum state machine | Effect continuation | call/cc or prompt | stream or trampoline |
| Backtracking | explicit search stack | success/failure CPS | continuation | explicit state machine |

Do not imitate a control operator that the target cannot safely express. In
Rust, compile suspension into an enum/Future state machine. In Bash, use an
explicit trampoline or stream; Bash has no safe general call/cc.`

export const FUNCTIONAL_LANGUAGE_GUIDES = `**TypeScript as a functional host:**
\`\`\`typescript
import { ok, mapResult, filterIterable, fold, call, done, trampoline, type Bounce } from './builtins/functional.js'

const total = fold(filterIterable([1, 2, 3, 4], n => n % 2 === 0), 0, (a, n) => a + n)
const parsed = mapResult(ok('42'), Number)
const countdown = (n: number): Bounce<string> =>
  n === 0 ? done('done') : call(() => countdown(n - 1))
console.log(total, parsed.ok ? parsed.value : parsed.error, trampoline(countdown(10_000)))
\`\`\`

Model state with discriminated unions, narrow by the tag, and finish switches
with an exhaustive \`never\` check. Compose async effects with \`attemptAsync\`
and \`bracket\`; keep pure transformation in Iterable generators so large inputs
stay lazy. Promise chains are sequencing, not parallelism unless work is started
before awaiting.

**Python as a functional host:**
\`\`\`python
from builtins_py.functional import Ok, Err, map_result, filter_iter, fold, Call, Done, trampoline

total = fold(filter_iter(range(1, 5), lambda n: n % 2 == 0), 0, lambda a, n: a + n)
def countdown(n):
    return Done('done') if n == 0 else Call(lambda: countdown(n - 1))
result = map_result(Ok('42'), int)
match result:
    case Ok(value): print(total, value, trampoline(countdown(10_000)))
    case Err(error): raise error
\`\`\`

Generator expressions and \`itertools\` are lazy pipelines; do not materialize
them unless random access or reuse requires it. Use frozen dataclasses plus
\`match/case\` for algebraic states, context managers for resource effects, and
\`async_bracket\` for asynchronous resource effects. Use the trampoline for
recursion deeper than Python's call-stack limit.

**Modern C++23 as a functional host:**
\`\`\`cpp
#include "builtins_c/functional.hpp"
#include <ranges>

int main() {
    auto values = std::views::iota(1, 11)
        | std::views::filter([](int n) { return n % 2 == 0; })
        | std::views::transform([](int n) { return n * n; });
    codeact::Result<int> total = codeact::fold(values, 0, std::plus<>{});
    if (!total) { std::cerr << total.error() << '\\n'; return 1; }
    std::cout << *total << '\\n';
}
\`\`\`

Prefer value semantics, concepts, ranges/views, \`std::expected\`, and
\`std::variant\` with \`codeact::overloaded\` visitation. RAII is the effect
handler for resources; \`scope_exit\` covers rollback. Views are non-owning and
lazy, so never return a view whose referenced storage has expired.`

export const BASH_CONTROL_GUIDE = `**Bash:**
\`\`\`bash
source ./builtins_bash/bash.sh
# Safe effects: read_file, write_file, mkdir_p, rm_rf, readdir, run_cmd, with_tempdir, with_cwd
# Streams: map_lines, filter_lines, fold_lines, scan_lines, take_lines, drop_lines, pipe_functions, map0
# Control: ok, err, continue_with, trampoline
\`\`\`

Treat Bash as a string/stream Lisp: commands are functions, pipelines compose
them, stdout carries values, stderr carries diagnostics, and exit status is a
Result. Quote every expansion unless splitting is intentional. Use arrays and
\`run_cmd program "arg with spaces"\`; reserve legacy \`exec_cmd\` for deliberately
authored shell programs, never data-derived arguments.`

export const ADVANCED_LANGUAGE_GUIDES = `**Rust:**
\`\`\`rust
// The header declares #[path = "builtins_rs/codeact.rs"] mod codeact;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let total: i64 = (1..=10).filter(|n| n % 2 == 0).sum();
    println!("{total}");
    Ok(())
}
\`\`\`

Prefer borrowing over cloning, Result over panic, iterator composition over
index loops, and an enum state machine when control can pause. A Rust Future is
a compiler-generated state machine driven by poll/Waker, not implicit parallelism.

**OCaml:**
\`\`\`ocaml
(* The header already opens Codeact. *)
let rec fold_left f acc = function
  | [] -> acc
  | x :: xs -> fold_left f (f acc x) xs
let () = Printf.printf "%d\\n" (fold_left ( + ) 0 [1; 2; 3])
\`\`\`

Prefer algebraic data types and exhaustive matches. Keep loops tail recursive.
Use Result/Option for expected failure. In OCaml 5, use Effect.Deep.try_with
plus perform/continue for resumable operations; continuations are one-shot, so
do not resume the same continuation twice.

**Scheme:**
\`\`\`scheme
;; codeact.scm is loaded automatically.
(display (call/cc (lambda (return) (return 42))))
(newline)
\`\`\`

Rely on proper tail calls for loops, \`dynamic-wind\` when resources cross a
continuation boundary, and hygienic macros for syntax. Use call/cc for genuine
non-local control, not ordinary iteration. Use the built-in trampoline when an
explicit sequence of thunks is clearer than capturing the whole continuation.`
