import { describe, expect, test } from "bun:test";
import {
	analyzeChapter,
	analyzeVoices,
	cosineSimilarity,
	bigrams,
	extractDialogue,
} from "../analyze.js";
import { checkChapter, checkManuscript } from "../check.js";

/** Prose with dialogue, several senses, and no checklist phrases. */
const CLEAN_CHAPTER = `
林砚推开门，木轴吱呀一声。灶上还温着粥，米香混着柴烟漫过来。

母亲没抬头，手里剥着蒜，说："你回来了。"

"嗯。"林砚把伞靠在墙角，指尖冻得发僵，又说："张叔说下月的账要提前结。"

母亲剥蒜的手停了一下，蒜皮落在膝上。"他上回也这么说。"

"这回不一样。"林砚在灶边蹲下，把手伸到火口上方。热气烫得他缩了缩，"我看见他把货单收进保险柜了。"

"你去过他后屋？"

"送账本的时候。"他顿了顿，"门没关严。"

母亲把蒜放进碗里，站起身。粥在锅里咕嘟一声，翻上来一颗焦黑的米。她盯着那颗米看了很久，才伸手去关火。

母亲说："这事你别管。"

林砚没答话。他闻到粥底糊了，味道发苦。窗外的雨还在下，敲在瓦上，一声一声。
`;

/** Same scene, rewritten with the checklist phrases the prompt lists. */
const TELLTALE_CHAPTER = `
在昏暗的灯光下，林砚陷入了沉思。

值得注意的是，母亲的态度不仅冷淡，更是带着一丝疏离。他心中涌起一股暖流，随即又被一种复杂的情绪所取代。

"你回来了。"母亲说。

"嗯。"林砚说。

与此同时，灶上的粥还在翻滚着。母亲若有所思地看着他，眼眶湿润。

毋庸置疑，这个家已经不是从前的样子了。这告诉我们，时间会改变一切。

他望着那口锅，看着那些明亮、温暖、熟悉、遥远的往事在眼前闪过。
`;

describe("analyzeChapter", () => {
	test("measures dialogue share and finds speakers", () => {
		const a = analyzeChapter(CLEAN_CHAPTER);
		expect(a.dialogueLines).toBeGreaterThan(5);
		expect(a.dialogueRatio).toBeGreaterThan(0.2);
		expect(a.speakers).toContain("母亲");
	});

	test("counts senses beyond the visual", () => {
		const a = analyzeChapter(CLEAN_CHAPTER);
		// 米香/柴烟 (smell), 吱呀/咕嘟 (sound), 冻得发僵/烫 (touch), 发苦 (taste)
		expect(a.sensory.nonVisualPresent.length).toBeGreaterThanOrEqual(3);
	});

	test("clean prose trips none of the AI tells", () => {
		expect(analyzeChapter(CLEAN_CHAPTER).tells).toHaveLength(0);
	});
});

describe("AI tell detection", () => {
	const tells = analyzeChapter(TELLTALE_CHAPTER).tells;
	const ids = tells.map((t) => t.id);

	test("catches formulaic emotion templates", () => {
		expect(ids).toContain("formulaic_emotion");
	});

	test("catches essay connectives", () => {
		expect(ids).toContain("essay_connectives");
	});

	test("catches 不仅…更是… escalation", () => {
		expect(ids).toContain("not_only_but_also");
	});

	test("catches mechanical scene transitions", () => {
		expect(ids).toContain("mechanical_transition");
	});

	test("catches translationese prepositions", () => {
		expect(ids).toContain("translationese_prepositions");
	});

	test("catches vague interiority", () => {
		expect(ids).toContain("vague_interiority");
	});

	test("catches authorial moralizing", () => {
		expect(ids).toContain("moralizing");
	});

	test("catches adjective pileups", () => {
		expect(ids).toContain("adjective_pileup");
	});

	test("reports line numbers so the writer can find each one", () => {
		const emotion = tells.find((t) => t.id === "formulaic_emotion")!;
		expect(emotion.examples.length).toBeGreaterThan(0);
		expect(emotion.examples[0]!.line).toBeGreaterThan(0);
		expect(emotion.examples[0]!.text).toContain("心中涌起");
	});
});

describe("checkChapter", () => {
	test("clean prose passes", () => {
		const report = checkChapter("07.md", CLEAN_CHAPTER);
		expect(report.verdict).toBe("clean");
		expect(report.checks.filter((c) => c.status === "fail")).toHaveLength(0);
	});

	test("says plainly that clean is not the same as good", () => {
		const report = checkChapter("07.md", CLEAN_CHAPTER);
		expect(report.reason).toContain("不证明写得好");
	});

	test("telltale prose needs revision", () => {
		const report = checkChapter("07.md", TELLTALE_CHAPTER);
		expect(report.verdict).toBe("needs_revision");
		expect(report.checks.find((c) => c.id === "ai_tells")!.status).toBe("fail");
	});

	test("flags a chapter that is nearly all narration", () => {
		const narration = "他走过长街。".repeat(200);
		const report = checkChapter("08.md", narration);
		const check = report.checks.find((c) => c.id === "dialogue_ratio")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("听不到人物的声音");
	});

	test("flags prose that only uses sight", () => {
		const visualOnly =
			"他看着那扇门。门是漆黑的，光线昏暗，轮廓模糊。他望向窗外，目光落在远处。".repeat(
				10,
			);
		const check = checkChapter("09.md", visualOnly).checks.find(
			(c) => c.id === "sensory_coverage",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("非视觉感官");
	});

	test("honours a stated length range", () => {
		const report = checkChapter("10.md", CLEAN_CHAPTER, {
			minDialogueRatio: 0.2,
			minNonVisualSenses: 2,
			minCharacters: 5000,
		});
		const check = report.checks.find((c) => c.id === "length")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("低于下限");
	});

	test("skips the length check when no range is given", () => {
		const report = checkChapter("11.md", CLEAN_CHAPTER);
		expect(report.checks.find((c) => c.id === "length")!.status).toBe(
			"skipped",
		);
	});

	test("a near-empty file is incomplete, not clean", () => {
		expect(checkChapter("12.md", "第一章").verdict).toBe("incomplete");
	});
});

describe("dialogue attribution", () => {
	test("reads both Chinese attribution orders", () => {
		const text = `
李默道："这条路我走过。"
"你确定？"王芝问。
`;
		const lines = extractDialogue(text);
		const bySpeaker = new Map(lines.map((l) => [l.speaker, l.text]));
		expect(bySpeaker.get("李默")).toBe("这条路我走过。");
		expect(bySpeaker.get("王芝")).toBe("你确定？");
	});

	test("does not credit one speaker's line to the next speaker", () => {
		// The trailing-speaker pattern must not reach across a paragraph break:
		// 母亲's line sits two lines above 林砚's attribution.
		const text = `母亲说："你回来了。"\n\n林砚说："嗯。"\n`;
		const lines = extractDialogue(text);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toEqual({ speaker: "母亲", text: "你回来了。" });
		expect(lines[1]).toEqual({ speaker: "林砚", text: "嗯。" });
	});

	test("does not read a negated verb as an attribution", () => {
		// "林砚没答话" is the narrator saying he stayed silent. Without the
		// negation guard the name capture swallows 没 and 答 matches as a speech
		// verb, inventing a speaker called 林砚没.
		const text = `"你去过他后屋？"\n\n林砚没答话。`;
		const speakers = extractDialogue(text)
			.map((l) => l.speaker)
			.filter(Boolean);
		expect(speakers).not.toContain("林砚没");
		expect(speakers).toHaveLength(0);
	});
});

describe("character voice distinctiveness", () => {
	test("identical registers are flagged as indistinguishable", () => {
		// Two characters, same clipped bureaucratic register, same vocabulary.
		const shared = [
			"根据规定，这件事需要走流程。",
			"根据规定，材料必须齐全，缺一样都不行。",
			"根据规定，我不能特批，请你理解。",
			"根据规定，请你按流程办理，先去窗口取号。",
			"根据规定，这个事情要按流程走完才能盖章。",
			"根据规定，材料交上来之后还要等审核。",
			"根据规定，这不是我一个人能定的事情。",
		];
		const map = new Map<string, string[]>([
			["科长", shared],
			["主任", [...shared]],
		]);

		const report = checkManuscript(map, 12);
		const check = report.checks.find((c) => c.id === "character_voices")!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("分不出是谁在说话");
	});

	test("genuinely different registers pass", () => {
		const map = new Map<string, string[]>([
			[
				"科长",
				[
					"根据规定，这件事需要走流程。",
					"材料必须齐全，缺一样都不行。",
					"我不能特批，请按程序办理。",
					"这是制度问题，不是态度问题。",
					"请你按窗口指引的顺序提交材料。",
					"审核期限以受理回执上的日期为准。",
					"逾期未补正的，按规定作退件处理。",
					"这个签字权限在分管领导那里。",
					"你可以先把复印件交上来，原件后补。",
				],
			],
			[
				"老周",
				[
					"哎哟，你别跟我扯那套。",
					"当年谁不是这么混过来的？",
					"喝口茶，慢慢说，急啥。",
					"我跟你讲，这事儿没那么邪乎。",
					"你瞅瞅你，急得跟啥似的。",
					"当年那会儿，谁还讲究这个哟。",
					"坐下坐下，站着说话腰疼。",
					"甭管他咋说，回头我给你问问。",
					"你这孩子，咋跟你爹一个脾气。",
					"我这把年纪，还能骗你不成。",
				],
			],
		]);

		const check = checkManuscript(map, 12).checks.find(
			(c) => c.id === "character_voices",
		)!;
		expect(check.status).toBe("pass");
	});

	test("speakers with too little dialogue are reported, not judged", () => {
		const map = new Map<string, string[]>([["路人甲", ["嗯。"]]]);
		const analysis = analyzeVoices(map);
		expect(analysis.underSampled).toContain("路人甲");
		expect(analysis.profiles).toHaveLength(0);
	});

	test("cosine similarity is 1 for identical text and lower for different", () => {
		const a = bigrams("根据规定这件事需要走流程");
		const b = bigrams("根据规定这件事需要走流程");
		const c = bigrams("哎哟你别跟我扯那套当年谁不是这么混过来的");
		expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
		expect(cosineSimilarity(a, c)).toBeLessThan(0.3);
	});
});

describe("foreshadowing ledger", () => {
	const map = new Map<string, string[]>();

	test("flags an item past its planned payoff chapter", () => {
		const check = checkManuscript(map, 15, [
			{
				id: "母亲的怀表",
				description: "第三章出现但没解释来历",
				planted: 3,
				plannedPayoff: 12,
				paidOff: null,
			},
		]).checks.find((c) => c.id === "foreshadowing")!;

		expect(check.status).toBe("fail");
		expect(check.detail).toContain("母亲的怀表");
		expect(check.detail).toContain("仍未回收");
	});

	test("flags an item planted long ago with no payoff planned", () => {
		const check = checkManuscript(map, 20, [
			{
				id: "邻居的狗",
				description: "第二章反复出现",
				planted: 2,
				plannedPayoff: null,
				paidOff: null,
			},
		]).checks.find((c) => c.id === "foreshadowing")!;

		expect(check.status).toBe("fail");
		expect(check.detail).toContain("无回收计划");
	});

	test("a paid-off item does not count against the ledger", () => {
		const check = checkManuscript(map, 15, [
			{
				id: "母亲的怀表",
				description: "已回收",
				planted: 3,
				plannedPayoff: 12,
				paidOff: 11,
			},
		]).checks.find((c) => c.id === "foreshadowing")!;

		expect(check.status).toBe("pass");
	});

	test("an empty ledger on a long manuscript is itself a finding", () => {
		const check = checkManuscript(map, 20, []).checks.find(
			(c) => c.id === "foreshadowing",
		)!;
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("台账是空的");
	});

	test("no ledger at all is skipped with instructions", () => {
		const check = checkManuscript(map, 20).checks.find(
			(c) => c.id === "foreshadowing",
		)!;
		expect(check.status).toBe("skipped");
		expect(check.detail).toContain("foreshadowing.json");
	});
});
