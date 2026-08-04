export const MANUSCRIPT_CHECK_TOOL_NAME = 'manuscript_check'

export const DESCRIPTION = `Mechanically check a Chinese-language manuscript for the machine-checkable half of prose quality.

**action: "chapter"** — reads one chapter file and reports:
- 去 AI 味清单 as patterns, not prose: formulaic emotion templates (心中涌起 / 眼眶湿润), essay connectives (值得注意的是 / 毋庸置疑), 不仅…更是… escalation, mechanical scene transitions (与此同时 / 镜头一转), translationese (在…中，/ 被…所…), vague interiority (陷入沉思 / 若有所思), adjective pileups, and authorial moralizing — each with line numbers and a fix
- dialogue as a share of the chapter, and how many distinct speakers the attribution patterns found
- sensory coverage across 视觉/听觉/触觉/嗅觉/味觉, with the non-visual count
- chapter length against a stated range
- the opening and closing 200 characters, quoted back for the writer to judge the hooks

**action: "manuscript"** — reads a chapters directory and checks what only shows up across chapters:
- character voice distinctiveness: dialogue is attributed per speaker and compared as character-bigram distributions. Two characters whose dialogue is statistically indistinguishable fail the check — this is Nova's "遮住名字也能分辨是谁在说话" rule made measurable
- foreshadowing ledger: given meta/foreshadowing.json, reports items past their planned payoff chapter and items planted long ago with no payoff planned

The verdict is clean / needs_revision / incomplete.

IMPORTANT: this tool checks for mechanical defects. A clean verdict means the prose has no detectable machine tells, adequate dialogue, and sensory range — it does not mean the chapter is good. Whether the hook lands, whether the emotional turn earns itself, whether the scene should exist at all: those remain judgment calls, and the tool says so rather than issuing a score that implies otherwise.`

export function getPrompt() {
  return `写完一章就查一章，不要攒到最后。

**逐章**: \`manuscript_check action=chapter path=chapters/07-xxx.md\`
可选 \`minDialogueRatio\` / \`minNonVisualSenses\` / \`minCharacters\` / \`maxCharacters\` 覆盖默认阈值。

命中 AI 痕迹的地方都带行号和改法。**逐条改，不要笼统地"润色一遍"** —— 那通常只会把命中的短语换成同一清单上的另一个。改完重跑。

**跨章**: \`manuscript_check action=manuscript chaptersDir=chapters\`
- 角色声音辨识度靠对话署名识别，所以正文里的对话要写成 \`角色名说：「……」\` 或 \`「……」角色名说\` 这类可识别的形式。识别不到说话人，这项检查就没有输入。
- 两个角色相似度过高时，回到角色记忆里的"语言风格"字段（口头禅/句式/用词偏好），给他们真正不同的说话方式，而不是换几个词。
- 伏笔台账放在 \`meta/foreshadowing.json\`:
\`\`\`json
[{"id": "母亲的怀表", "description": "第三章出现但没解释来历",
  "planted": 3, "plannedPayoff": 12, "paidOff": null}]
\`\`\`
每埋一个伏笔就加一条，每回收一个就填 \`paidOff\`。这样"哪些伏笔快忘了"就不再依赖你记得住。

**裁定怎么读**: \`clean\` 只说明没有机械毛病，不说明写得好——钩子是否抓人、情感转折是否站得住、这一场该不该存在，工具不裁定，你自己读。\`needs_revision\` 就按每项 detail 改。`
}
