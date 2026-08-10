/** Language-specific control knowledge kept separate from tool mechanics. */

export const CONTROL_STRUCTURE_GUIDE = `### Control-structure playbook

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
