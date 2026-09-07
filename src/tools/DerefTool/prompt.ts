export const DEREF_TOOL_NAME = 'Deref'

export const DESCRIPTION = `Read exact lines from a large tool result that was replaced by a handle.

When a tool produces a lot of output, the full text is kept out of the conversation and you receive a compact reference instead — a line like:

  [handle:res_0007_a1b2] Read result — 3120 lines, 184023 chars

That result's bytes still exist verbatim; they are simply not occupying context. This tool retrieves any range of them.

Use it when you need the exact content behind a handle: before editing code you have only seen summarized, to read a region a summary pointed at, or to check a specific line the summary quoted.

Line numbers are 1-based and inclusive of both ends, and they are the same numbers shown in the handle's preview and in any summary of it. Omit both to retrieve the whole thing — prefer a range, since the point of the handle is to keep the bulk of it out of context.

A handle belongs to the current session. If it has been evicted the call fails and names the handles that are still available; re-run the original tool in that case.`
