/**
 * quant-lifecycle — make the Quant agent's state machine structural.
 *
 * Quant's own system prompt argues for this better than a comment can:
 *
 *   "结构优先于告诫 … 这些纪律的执行不依赖你逐条记得，而依赖把它们编码进
 *    文件状态和工具裁定 … 能落到文件与工具契约上就不要只靠自觉。"
 *
 * And then the lifecycle — Research Brief → Study → Session → Run → Report,
 * "a Run is an immutable measurement, no deleting, no overwriting, no
 * re-running until it looks good" — is enforced by the model having read a
 * paragraph about it a hundred thousand tokens ago. That is exactly the
 * exhortation the prompt says not to rely on.
 *
 * This is the same rule as a tool contract. `research.md` has to exist before
 * a Run is allowed, and a Run's outputs cannot be deleted. Two hooks, no
 * tokens, and the discipline holds in turn four hundred the same as in turn
 * one.
 *
 * Scoped to one agent type on purpose: a guard that fires on somebody else's
 * tool calls is a guard nobody will keep switched on.
 */

export const manifest = {
  description: "Enforce Quant's Brief → Study → Run lifecycle structurally.",
  position: 'outer',
  capabilities: [],
}

export function register(on: any, options: any, ctx: any) {
  const agentType: string = options?.agentType ?? 'quant'
  const briefName: string = options?.brief ?? 'research.md'
  const runTools: string[] = options?.runTools ?? ['quant_verify']
  // Anchored on a word boundary, not on the start of the string: the thing
  // being matched is a command line, so `runs/` turns up after `rm -rf `,
  // never at position zero. The first version of this anchored at ^ and
  // matched nothing, which a guard cannot tell you about itself.
  const runDirPattern = new RegExp(options?.runDirPattern ?? '(^|[\\s/"\'])runs?/')

  const briefSeen = new Set<string>()

  const mentionsBrief = (input: any): boolean => {
    const text = JSON.stringify(input ?? {})
    return text.includes(briefName)
  }

  on('tool.call', async ($: any, e: any, next: any) => {
    // Only this agent's calls; every other subagent and the main session go
    // straight through. agent_type is set for a `--agent quant` main session
    // too, and that session wants the same lifecycle, so the filter is on
    // type rather than on agent_id being present.
    if (e.agent_type !== agentType) return next(e)
    // agent_id is absent on the main thread by design — it is what tells a
    // subagent call apart from a main-thread one — so the root session gets
    // its own key rather than sharing `undefined` with everything.
    const agentId = e.agent_id ?? 'root'
    const tool = e.tool_name ?? e.tool

    // Writing the brief is what opens the lifecycle.
    if ((tool === 'Write' || tool === 'Edit') && mentionsBrief(e.tool_input ?? e.input)) {
      briefSeen.add(agentId)
      ctx.ui.toast({
        key: `quant-brief-${agentId}`,
        text: `quant: ${briefName} written — Runs unlocked`,
        color: 'success',
      })
      return next(e)
    }

    if (runTools.includes(tool) && !briefSeen.has(agentId)) {
      // The prompt's own words, handed back at the moment they apply rather
      // than a hundred thousand tokens earlier.
      return {
        deny:
          `Lifecycle: no Run before a Research Brief. Write ${briefName} first ` +
          `(problem, falsifiable hypothesis, evaluation, stop condition), then ` +
          `re-run ${tool}. 结构优先于告诫 — this is that structure.`,
      }
    }

    // A Run is an immutable measurement. Deleting one is the failure the
    // prompt names outright: re-running until it looks good.
    if (tool === 'Bash') {
      const command = String((e.tool_input ?? e.input)?.command ?? '')
      if (/\brm\b/.test(command) && runDirPattern.test(command)) {
        return {
          deny:
            `A Run is an immutable measurement — including the ones that failed. ` +
            `Refusing to delete under runs/. Start a sibling Study instead.`,
        }
      }
    }

    return next(e)
  })

  on('subagent.stop', ($: any, e: any, next: any) => {
    briefSeen.delete(e.agent_id)
    return next(e)
  })
}
