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

To hand one to every user of the desktop instead of one machine, add its name to
`DESKTOP_BUNDLED_MODS` in
`apps/desktop/backend/src/autoagent_backend/adapters/engine/bundled_mods.py`:
every session the desktop starts then gets it from `OPENCC_BUNDLED_MODS`, and a
person can still switch it off in the Plugins panel. The operational mods below
(`kill-guard`, `cache-stats`, `swarm-dashboard`, `skill-index`, `awr-fleet`) are
deliberately *not* on that list — a guard, a roster and an index are choices a
line has to make, not defaults to impose.

| mod | what it does |
|---|---|
| `subagent-trace` | Replaces the subagent dashboard with per-agent current tool, call count, denials and a phase label. Reads phase names from `mod.json`, so it works for any agent without editing the mod. `ctrl+s` collapses it. |
| `quant-lifecycle` | Turns the Quant agent's Brief → Study → Run lifecycle from prose in its system prompt into a tool contract: no Run before `research.md` exists, and no deleting a Run afterwards. |
| `tetris` | Playable, in the transcript, at the `overlay` slot. `ctrl+g` to start. It is here because it fails loudly if any part of the UI surface is fake — a panel would not. |
| `token-meter` | The terminal's context gauge (green bar, `575k/967k tokens · 41% left · $93.81`) above the desktop's composer, and tokens, cost and a per-model split in its Plugins tab, from `usage.record`. Bundled with the desktop, so on by default. |
| `desktop-tool-ledger` | Counts tool calls and denials and draws them in the HydraHub desktop: a pane in the Plugins tab and a line above the composer. "Ask about it" puts a prompt in the composer rather than calling the model. |
| `test-panel` | The tester's panel in the HydraHub desktop: dispatched test tasks, CT reports and the defect board. A native `test-panel` contribution with no actions; the host owns the UI and reads `/api/cloud/*`. Bundled with the desktop, so on by default. |
| `awr-panel` | The AWR robot line in an overlay: `ctrl+shift+r` toggles, working / faulty / OTA progress per robot. Reads a snapshot (file or command, `OPENCC_AWR_SNAPSHOT`) because this process has no ROS client — and says so when there is none. Its `refresh` command is the worked example of the command layer: key, `opencc mods run awr-panel refresh`, and `$.mods.run` all reach one handler. |
| `kill-guard` | Refuses the three ways this machine has actually lost a session: `kill <pid>` with no `ps -p` in the same command, `pkill -f <pattern>` without the `[/]` self-exclusion, and any signal to `systemd`, `systemd --user`, `gdm`, `dbus-daemon`, `sshd`, `feishu_bridge.py` or `killall5`. A refusal is a `deny` with the reason, so the model reads why. `rules` prints the list. |
| `cache-stats` | The cache half of `token-meter`: prompt-cache hit rate over read / written / plain input, per day and per session, in the composer. Keeps a day ledger on disk and notes each compaction, because that is when the next turn's hit rate is expected to dip. `stats` and `reset` are commands. |
| `swarm-dashboard` | The swarm as a panel and a `swarm.state` service: every coroutine still open with its worker, recovery attempts and age, and every actor whose presence file is recent enough to count as live. Reads `<config>/coroutines/*/state.json` and `<config>/actors/*/*.presence.json`; `show` returns the same snapshot as JSON. |
| `skill-index` | Indexes every `SKILL.md` under `<cwd>/skills`, `<config>/skills` and `~/.claude/skills`, and on each prompt scores names and descriptions against it (IDF-weighted overlap, no embeddings). Recommends three in the composer; `options.inject: true` appends them to the prompt instead. `find --arg query=…` is a command, so another mod can retrieve from it too. |
| `awr-fleet` | The roster as a service (`awr.fleet`: `list`, `get`, `busy`, `otaInFlight`, `stale`, `snapshot`) plus a panel, from `$AWR_ROSTER` or `~/.awr/robots.json`. The panel says when the roster is stale, when it is placeholder data (`sample: true`) and when it cannot be read — an annotation no dashboard should omit. `fleet` prints the table. |

Position is not cosmetic. `subagent-trace`, `quant-lifecycle`, `tetris`,
`cloud-channels`, `excalidraw-whiteboard`, `desktop-tool-ledger`, `awr-panel`
and `kill-guard` are `outer`; `token-meter`, `test-panel`, `cache-stats`,
`swarm-dashboard`, `skill-index` and `awr-fleet` are `inner` and only observe.
For `subagent-trace` outer is load-bearing: the built-in dashboard returns its
own node without calling `next(e)`, so an inner mod would never run.
`desktop-tool-ledger` is outer so it sees the calls a guard refuses, and
`kill-guard` is outer so it refuses before any built-in runs.

None of them spends a single model token. A mod is ordinary code in the
agent's process: it reacts to events the agent generates, and — as tetris
shows — may own a timer, a rectangle and the keyboard while it does.
