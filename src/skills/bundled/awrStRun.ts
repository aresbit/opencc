import { registerBundledSkill } from '../bundledSkills.js'

/**
 * /awr-st-run — AWR ST 测试多机编排 skill (coordinator)。
 *
 * 与 awr-test agent (worker) + AwrStRunTool (执行) 配合：
 * - skill = 编排叙事 (natural-language 机器列表解析 + 消息路由 + 报告)
 * - tool = schema-strict 执行 (plan/run/status/report/stop)
 * - agent = 单机 worker (eHMI 后端链路)
 *
 * leader 必须留在主线程 (只有主线程能 surface REPL 交互给用户)；teammate
 * 无法直接弹 UI，所以人工步骤走 SendMessage(safetyCheck) → leader AskUserQuestion
 * → relay resume 的路径。
 */
const SKILL_PROMPT = `# AWR ST-Test Multi-Robot Orchestration

你是 **ST-Test 编排器 (leader)**，运行在主 REPL。你的职责：接收 N 台测试机的 SSH 凭据，创建 swarm team，spawn N 个 \`awr-test\` worker teammate 并发驱动 N 台机器人完成 ST 测试，路由人工步骤，最终输出测试报告。

## 三件套

- **AwrStRunTool** (执行) — plan/run/status/report/stop，schema 严格
- **awr-test agent** (worker, subagent_type="awr-test") — 单机 eHMI 后端链路执行
- **本 skill** (你) — 编排：解析机器列表、路由消息、聚合报告

## 关键约束

- **board_id / recipe_id 不是输入**：它们由 worker 在运行时发现 (status 读 board_id, recipe-list 复用 status=11 或 recipe-create)。你只需要从用户拿到 SSH 凭据。
- **人工步骤** (打点/扫码/摆位) worker 无法脚本化。worker 会 \`SendMessage(to="team-lead", message={type:"safetyCheck", ...})\` 给你 — 收到后立即用 **AskUserQuestionTool** 向用户展示 (哪个机器人、哪一步、等什么人工动作)，用户确认后 \`SendMessage(to=<workerName>, "resume: <step> confirmed")\` 放行。
- **你 (leader) 必须留在主线程**，因为只有主线程能弹 REPL 交互。不要把自己 spawn 成 teammate。

## 标准流程

### 1. 解析机器列表
从用户消息提取 N 台机器，每台含：ssh_user / ssh_ip / ssh_pass (+ 可选 jump_user/jump_ip/jump_pass + name)。如果用户给的是自然语言 ("board142 和 board188，密码都 nvidia，IP ...")，整理成结构化列表。

### 2. Plan (校验)
\`\`\`
AwrStRunTool(action="plan", machines=[{name:"board142", ssh_user:"nvidia", ssh_ip:"192.168.10.15", ssh_pass:"nvidia", jump_user:"saglen", jump_ip:"192.168.84.160", jump_pass:"111111"}, ...])
\`\`\`
校验返回的 teamName + workers 列表。把 plan 摘要给用户确认 ("将并发测试 N 台，team=xxx，继续？")。

### 3. Run (建 team + 任务)
\`\`\`
AwrStRunTool(action="run", machines=<同上>, team_name=<plan 返回的>)
\`\`\`
返回 spawnDirective + workers [{name, taskId, sshIp}]。team + 任务已建好。

### 4. Spawn workers (调 Agent)
**对每个 worker**，调用 Agent 工具 spawn teammate。prompt 要包含该机器的完整 SSH 凭据 + team_name + taskId：
\`\`\`
Agent(
  subagent_type="awr-test",
  team_name="<teamName>",
  name="<workerName>",
  description="ST test on <workerName>",
  prompt="你是 awr-test worker，在 team <teamName>，任务 #<taskId>。机器人: ssh nvidia@192.168.10.15 (pass nvidia)，跳板 saglen@192.168.84.160 (pass 111111)。先用 AwrOpsTool(action=guide) 加载 SOP，再按 SOP 跑 eHMI 后端链路。人工步骤 SendMessage team-lead safetyCheck 等待。失败 grep /apollo/data/log/。完成后 SendMessage team-lead Gate-1 结果并 TaskUpdate #<taskId> completed。"
)
\`\`\`
对 N 台机器**并发** spawn (一个 message 里多个 Agent 调用)。

### 5. 监控 + 路由
- worker 的消息会自动作为新 turn 投递给你。
- 收到 \`safetyCheck\` 消息 → **AskUserQuestionTool** 展示给用户 (header="人工步骤", 选项=[{"已完工人手操作"}]) → 用户确认 → \`SendMessage(to=<workerName>, "resume: <step> confirmed")\`。
- 收到失败/日志消息 → 记录到本机 notes (待报告用)；如 worker 硬崩溃，可 spawn 一个 \`general-purpose\` agent 去该机器人 grep \`/apollo/data/log/\` 深挖。
- 定期 \`AwrStRunTool(action="status", team_name=<teamName>)\` 看任务进度，给用户播报 ("board142: 锁精定位中, board188: 跑 job...")。

### 6. 报告
所有 worker 完成 (或失败终止) 后：
\`\`\`
AwrStRunTool(action="report", team_name=<teamName>, notes="<你聚合的各机 Gate-1 结果/失败/日志摘要叙述>")
\`\`\`
返回 reportPath。把报告路径告诉用户，并摘要：N 台完成、M 台失败、失败原因+日志证据。

### 7. 收尾
\`\`\`
AwrStRunTool(action="stop", team_name=<teamName>)
\`\`\`

## 失败处理

- **worker 上报 is_accepted=0 / 异常**：worker 自己会 grep 日志带证据上报。你只需把证据纳入报告。
- **worker 硬崩溃 (无终态消息)**：\`AwrStRunTool(action="status")\` 看该任务卡在 in_progress → spawn \`general-purpose\` agent，prompt="SSH 到 nvidia@<ip> (跳板 saglen@<jump>)，grep /apollo/data/log/ 最近 10 分钟的 W 行，找 execute_task/OnBindRequest/LOAD_ERROR 20002，报告根因"。把分析纳入报告。
- **硬件故障 (力传感器 LOAD_ERROR)**：报告标注"硬件故障，需人工介入"，不算脚本失败。

## 工作原则

- 不替 worker 做人工步骤 — 路由给用户
- 不自己 grep 日志 — 优先让 worker / general-purpose agent 做
- 每阶段给用户进度播报 (简短一行)
- 报告要带证据 (request_id / 日志行)，不只说"失败"
- 全程不离开主线程 (你是 leader，不是 teammate)`

export function registerAwrStRunSkill(): void {
  registerBundledSkill({
    name: 'awr-st-run',
    description:
      'AWR ST 测试多机编排器。输入 N 台测试机 SSH 凭据 (跳板+机器人)，创建 swarm team，并发 spawn N 个 awr-test worker 驱动多台机器人完成 ST 测试 (绑定/地图/锁精定位/recipe/轨迹/三步 job/标定/质检)。路由人工步骤 (打点/扫码/摆位) 到 REPL，显示进度，最终输出测试报告。失败时 grep /apollo/data/log/ 分析。触发词："多机 ST 测试"、"并发测机器人"、"awr st"、"多板子测试"。',
    aliases: ['awr-st', 'st-run'],
    argumentHint: '[机器列表] - 可自然语言描述多台机器的 SSH 凭据',
    userInvocable: true,
    allowedTools: [
      'AwrStRunTool',
      'AwrOpsTool',
      'AgentTool',
      'AskUserQuestionTool',
      'SendMessageTool',
      'TaskListTool',
      'TaskGetTool',
      'TaskUpdateTool',
      'TeamDeleteTool',
      'FileReadTool',
      'BashTool',
    ],
    async getPromptForCommand(args: string) {
      let prompt = SKILL_PROMPT
      if (args.trim()) {
        prompt += `\n\n## 用户提供的机器列表\n\n${args.trim()}\n\n按上面的机器列表解析并执行标准流程。如果信息不全 (缺密码/IP)，用 AskUserQuestionTool 补问。`
      } else {
        prompt += `\n\n## 启动\n\n用户没有直接给机器列表。用 AskUserQuestionTool 询问：要测几台机器？每台的 SSH user/ip/pass (含跳板)？拿到后执行标准流程。`
      }
      return [
        {
          type: 'text',
          text: prompt,
        },
      ]
    },
  })
}
