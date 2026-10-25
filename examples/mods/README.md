# Example mods

Copy one into place and restart:

```bash
cp -r examples/mods/subagent-trace ~/.claude/mods/
```

In the HydraHub desktop, paste the folder's path into Plugins → Hook 插件 →
安装 MOD instead: the desktop's engine has its own config directory, not
`~/.claude`. New sessions pick it up.

They are not loaded from here — `~/.claude/mods/` and `<project>/.claude/mods/`
are the two discovery roots. See `src/services/functionHooks/README.md` for what
a mod is and what its manifest means.

| mod | what it does |
|---|---|
| `subagent-trace` | Replaces the subagent dashboard with per-agent current tool, call count, denials and a phase label. Reads phase names from `mod.json`, so it works for any agent without editing the mod. `ctrl+s` collapses it. |
| `quant-lifecycle` | Turns the Quant agent's Brief → Study → Run lifecycle from prose in its system prompt into a tool contract: no Run before `research.md` exists, and no deleting a Run afterwards. |
| `tetris` | Playable, in the transcript, at the `overlay` slot. `ctrl+g` to start. It is here because it fails loudly if any part of the UI surface is fake — a panel would not. |
| `token-meter` | The terminal's context gauge (green bar, `575k/967k tokens · 41% left · $93.81`) above the desktop's composer, and tokens, cost and a per-model split in its Plugins tab, from `usage.record`. Bundled with the desktop, so on by default. |
| `desktop-tool-ledger` | Counts tool calls and denials and draws them in the HydraHub desktop: a pane in the Plugins tab and a line above the composer. "Ask about it" puts a prompt in the composer rather than calling the model. |

All but `token-meter` use `position: "outer"`; it only observes. For `subagent-trace` that is
load-bearing: the built-in dashboard returns its node without calling
`next(e)`, so an inner mod would never run. `desktop-tool-ledger` is outer so
it sees the calls a guard refuses.

None of them spends a single model token. A mod is ordinary code in the
agent's process: it reacts to events the agent generates, and — as tetris
shows — may own a timer, a rectangle and the keyboard while it does.
