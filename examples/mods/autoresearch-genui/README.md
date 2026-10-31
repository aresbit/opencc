# autoresearch-genui

An example mod that turns an Autoresearch tool result into an inline GenUI
card in the conversation.

It is the smallest complete example of the algebraic-effect loop:

```text
tool.invoke hook
  └─ read { data: Output } from the tool result
       └─ build a declarative tree from the tool result
            └─ ctx.desktop.slot('conversation', () => ({ tree, anchorMessageId }))
                 └─ host renders it after the assistant message
```

- `tool.invoke` carries the structured `ToolResult<Output>`; its `data` field is
  what the tree is built from.
- `tool.content` carries only the rendered message string (for this tool, the
  prose in `message`), so parsing a tree there yields `null` for every action.
- `tool.result` is the PostToolUse event object, not the tool output.
- The tree uses the shared declarative vocabulary: `Box`, `Metrics`, `Chart`,
  `Table`, `Callout`.
- `anchorMessageId` is optional. If the hook input does not carry a message id,
  the host renders the contribution at the end of the conversation.
- The mod never touches the transport or the renderer; it only names data.

The desktop loads it as a bundled mod (see
`apps/desktop/backend/src/autoagent_backend/adapters/engine/bundled_mods.py`).
