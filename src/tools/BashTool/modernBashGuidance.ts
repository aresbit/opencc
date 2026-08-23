/**
 * Built-in guidance distilled from the modern-bash skill.
 *
 * Keep this in the Bash tool prompt instead of sourcing a helper library into
 * every command. Runtime helpers such as run_cmd would hide the real executable
 * from Bash permission-prefix analysis. CodeAct Bash is the safe home for those
 * helpers because it executes the whole reviewed script in one bounded call.
 */
export function getModernBashGuidance(): string {
  return [
    '# Modern Bash: commands as functions, pipelines as composition',
    '',
    'Use the "string Lisp" model when constructing shell work:',
    '- Values crossing command boundaries are byte/string streams. Treat stdout as the result channel, stderr as diagnostics, and exit status as success/failure information.',
    '- Treat side-effect-free commands as functions and pipelines as left-to-right composition. Keep filesystem, process, network and working-directory effects explicit and late.',
    '- Before execution, reason about static semantics (quoting, expansions, scope and syntax), then dynamic semantics (subshells, pipeline status, evaluation order and side effects).',
    '',
    'Correctness rules:',
    '- Quote expansions by default: `"$value"`, `"$' +
      '{items[@]}"` and `-- "$path"`. Use arrays for argument vectors; never store a command in a string or use `eval` for data-derived input.',
    '- Do not parse `ls`, and do not iterate over `$(...)` when records may contain whitespace or glob characters. For line records use `while IFS= read -r line || [[ -n $line ]]`; for filenames that may contain newlines use NUL-delimited producers/consumers.',
    "- Prefer `printf '%s\\n'` to `echo` for data. Remember that command substitution removes trailing newlines and normally runs in a subshell, so state changes inside it do not update the parent shell.",
    "- In functions, declare locals explicitly. Split declaration from command substitution (`local value; value=$(command)`) so the command's failure status is not masked.",
    '- Propagate meaningful non-zero statuses. Do not assume every non-zero status is an error: predicates and tools such as grep/diff use status to represent ordinary outcomes.',
    '- When creating or reviewing a standalone `.sh` script, validate it with `bash -n`; use `shellcheck` when it is installed, then exercise empty input, spaces, glob characters, missing final newlines and command failures.',
    '- For GitHub archive downloads, never assume the branch is `main` or `master`. Resolve `default_branch` with `gh api repos/OWNER/REPO --jq .default_branch` or the GitHub API, use `curl --fail --location`, and validate with `tar -tzf` before extraction.',
    '',
    'Execution boundary:',
    '- Use BashTool for one command or a short dependency chain. Its actual interactive shell may be bash or zsh, and shell variables/functions do not persist between calls, so keep commands portable and self-contained.',
    '- Use CodeAct with `language: "bash"` for Bash-specific syntax, functions, loops, accumulators or multi-stage transformations. It supplies `set -euo pipefail` plus `map_lines`, `filter_lines`, `fold_lines`, `scan_lines`, `take_lines`, `drop_lines`, `pipe_functions`, `map0`, `run_cmd`, `with_cwd` and `with_tempdir`.',
  ].join('\n')
}
