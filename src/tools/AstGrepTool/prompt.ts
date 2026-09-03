export const AST_GREP_TOOL_NAME = 'ast_grep'

export const DESCRIPTION = `Search code by its syntax tree instead of its text.

Two ways to ask. A \`kind\` matches by AST node type — \`function_declaration\`, \`class_declaration\`, \`call_expression\` — and answers "every X". A \`pattern\` is a fragment of real code with metavariables in it, and answers "this exact shape": \`$NAME\` captures one node, \`$$$ARGS\` captures a run of them. Either way, whitespace, line breaks and formatting do not matter.

\`\`\`
kind: "function_declaration"                  every function declaration
pattern: "await $PROMISE"                     every await, however it is written
pattern: "catch ($E) { }"                     empty catch blocks
pattern: "useEffect(() => { $$$ }, [])"       mount-only effects
\`\`\`

Use it when the thing you are looking for is a shape rather than a string: every call to a function regardless of how the arguments are spread across lines, every empty catch, every class that extends something. Grep finds those only by guessing at their text, and a regex that tries to match nested brackets is a regex that is wrong on some file you have not read.

Inputs:
- \`pattern\`: the code shape to find.
- \`kind\`: the AST node type to find. Combines with \`pattern\` to narrow it.
  One of \`pattern\` or \`kind\` is required.
- \`path\`: file or directory to search. Defaults to the working directory.
- \`language\`: forced language. Normally inferred per file from its extension, which is what you want when a directory holds more than one.
- \`glob\`: narrow the file set. These are ripgrep globs, exactly as the Grep tool takes them.
- \`head_limit\`: cap the number of matches returned.

Returns each match with its file, line, and the matched text, plus what every metavariable captured.

When NOT to use it: searching prose, config, logs, or any file with no grammar here; finding a literal string (Grep is faster and does not need to parse); or a question about one file you have already read.`

export function getPrompt() {
  return `**A pattern matches the whole shape, including the parts you did not think about.** This is the trap, and it fails silently. Measured on this repository: \`export function $N($$$) { $$$ }\` returns **2** matches against **41** \`export function\` declarations. The 39 it misses have a return type, and \`: number\` is part of the signature the pattern must also match. \`export function $N($$$): $R { $$$ }\` finds those 39 and misses the other 2.

So: **\`kind\` for "every X", \`pattern\` for "this exact shape".** \`kind: "function_declaration"\` finds all 41. Reach for a pattern when the shape *is* the question — a particular call, a particular wrapper. When a search returns suspiciously few results, this is the first thing to check.

**One node or many.** \`$A\` is exactly one node; \`$$$A\` is zero or more. \`foo($A)\` matches a one-argument call and nothing else — \`foo($$$A)\` is what matches any call to \`foo\`.

**Metavariable names must be uppercase.** \`$name\` is not a capture; it is a literal.

**A pattern that does not parse is reported, not answered.** The tool checks the pattern before reading any file, so a broken one comes back as an error instead of an empty result. An empty result therefore means what it says.

**Language is per file, from its extension.** Pass \`language\` only to override that — for a file with an unusual extension, or to read \`.ts\` as \`tsx\`.

**Globs are ripgrep globs.** To scope to a subdirectory write \`**/sub/**\`; a bare \`sub/**\` matches nothing, the same as in the Grep tool.

**Node kinds are the grammar's, not a fixed list.** They differ per language — a Python function is \`function_definition\`, a TypeScript one is \`function_declaration\`. If a kind returns nothing, search for a small example with a pattern first and read the kind off the result.`
}
