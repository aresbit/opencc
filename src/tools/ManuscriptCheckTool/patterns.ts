/**
 * The "去 AI 味" checklist, as patterns instead of prose.
 *
 * Nova's prompt already lists these tells — the formulaic emotion phrases, the
 * translationese, the mechanical scene transitions. Asking a model to audit its
 * own prose for them catches the obvious cases and misses the rest, because the
 * phrases are exactly the ones that felt natural to write. A regex does not get
 * tired of its own writing.
 */

export type TellSeverity = 'high' | 'medium'

export interface AiTellPattern {
  id: string
  /** What to look for. Global + multiline. */
  pattern: RegExp
  /** Why it reads as machine-written. */
  why: string
  /** What to do instead. */
  fix: string
  severity: TellSeverity
}

export const AI_TELL_PATTERNS: AiTellPattern[] = [
  {
    id: 'formulaic_emotion',
    pattern:
      /(心中(?:涌起|升起|泛起)|眼眶(?:湿润|一热|微红)|心潮澎湃|心头一紧|一股暖流|百感交集|思绪万千|五味杂陈)/g,
    why: '情感描写的万能模板——这些短语可以安在任何角色任何场景上，因此不描写任何具体的人。',
    fix: '换成只有这个角色在这个处境下才会有的具体动作或生理反应。',
    severity: 'high',
  },
  {
    id: 'essay_connectives',
    pattern:
      /(值得注意的是|毋庸置疑|显而易见|不可否认|总而言之|综上所述|由此可见|众所周知)/g,
    why: '论文腔的连接词。叙事里出现，等于作者跳出来对读者讲解。',
    fix: '删掉。让情节自己承担说服工作。',
    severity: 'high',
  },
  {
    id: 'not_only_but_also',
    pattern: /不仅[^。！？\n]{0,30}(?:更是|而且|还)/g,
    why: '"不仅…更是…"是最典型的 AI 递进句式，密集出现时全文节奏会变得单调。',
    fix: '拆成两个短句，或直接删掉递进关系。',
    severity: 'high',
  },
  {
    id: 'mechanical_transition',
    pattern: /(?:^|\n)\s*(与此同时|另一边|镜头一转|话分两头|且说)/g,
    why: '机械的场景转换词，像剧本调度说明而不是叙事。',
    fix: '用空行或分隔符切场，或让新场景的第一个具体细节完成过渡。',
    severity: 'medium',
  },
  {
    id: 'translationese_prepositions',
    // Anchored to clause start: "他在灶边蹲下，" is a verb complement and fine;
    // "在昏暗的灯光下，" opening a sentence is the translationese tell.
    pattern: /(?:^|[。！？\n])\s*在[^，。！？\n]{2,12}(?:中|下|里)，/gm,
    why: '"在…中/下/里，"起句的翻译腔句式，中文原生表达很少这样开头。',
    fix: '改成主谓结构直接开场。',
    severity: 'medium',
  },
  {
    id: 'passive_bei_suo',
    pattern: /被[^，。！？\n]{0,10}所[^，。！？\n]{0,6}/g,
    why: '"被…所…"的双重被动，书面翻译腔。',
    fix: '改主动语态。',
    severity: 'medium',
  },
  {
    id: 'vague_interiority',
    pattern: /(陷入了?沉思|若有所思(?:地)?|不禁陷入|思考着什么|愣在原地|心情复杂)/g,
    why: '空泛的心理描写，读者得不到任何具体信息。',
    fix: '给出角色实际想到的画面、记忆片段或下一个动作。',
    severity: 'high',
  },
  {
    id: 'adjective_pileup',
    // Four or more consecutive two-character descriptive compounds.
    pattern: /(?:[一-龥]{2}(?:、|，)){3,}[一-龥]{2}/g,
    why: '形容词堆砌。堆四个词的信息量通常低于一个具体细节。',
    fix: '留最准的一个，其余换成能看见的细节。',
    severity: 'medium',
  },
  {
    id: 'moralizing',
    pattern: /(这告诉我们|这说明了?一个道理|人生就是这样|或许这就是[^。\n]{0,10}吧)/g,
    why: '说教段落，作者越过角色直接对读者总结。',
    fix: '删掉。读者不需要被告知刚才那一幕的意义。',
    severity: 'high',
  },
]

// ── Sensory lexicons ──────────────────────────────────────────────
//
// "感官平衡"和"每章 ≥ 2 种非视觉感官"是 Nova 的硬指标，而它们是可数的。

export type Sense = 'visual' | 'auditory' | 'tactile' | 'olfactory' | 'gustatory'

export const SENSE_LABELS: Record<Sense, string> = {
  visual: '视觉',
  auditory: '听觉',
  tactile: '触觉',
  olfactory: '嗅觉',
  gustatory: '味觉',
}

export const SENSORY_LEXICON: Record<Sense, RegExp> = {
  visual:
    /(看|望|瞧|瞥|凝视|注视|目光|颜色|光线|阴影|明亮|昏暗|苍白|通红|漆黑|闪烁|轮廓)/g,
  auditory:
    /(听|声音|响|嘈杂|寂静|喧哗|低语|呢喃|尖叫|嘶哑|轰鸣|滴答|脚步声|回音|吱呀)/g,
  tactile:
    /(摸|触|碰|握|捏|贴|按|冰凉|滚烫|温热|粗糙|光滑|刺痛|麻木|颤抖|发抖|沉甸甸|黏腻|干燥|冻|烫|发僵|暖|凉|痒|扎手)/g,
  olfactory:
    /(闻|气味|味道扑|香气|[一-龥]香(?!港)|臭|腥|霉味|烟味|酒气|药味|尘土味|汗味|焦味|馊)/g,
  gustatory:
    /(尝|咬|嚼|吞|舌尖|苦涩|甘甜|发苦|回甘|涩口|腥甜|酸|辣|咸|甜|苦)/g,
}

// ── Dialogue extraction ───────────────────────────────────────────

/**
 * Text inside quotation marks. Drafts arrive with 全角 “”, 直角 「」, or plain
 * ASCII quotes depending on the editor, so all three count as dialogue.
 */
export const DIALOGUE_SPAN = /[“「"]([^”」"\n]{1,400})[”」"]/g

/**
 * Speaker attribution, both orders Chinese prose uses:
 *   角色名说：“……”  /  角色名道：“……”
 *   “……”角色名说
 */
export const SPEECH_VERBS =
  '笑道|冷笑|叹道|低声道|轻声说|反问|接话|应道|回道|回答|嘟囔|说|道|问|答|喊|叫|骂'

/**
 * A negated verb is not an attribution: "林砚没答话" would otherwise be read as
 * the speaker "林砚没" saying something, because the name capture happily
 * swallows the negation and leaves 答 to match as the speech verb.
 */
const NOT_NEGATED = '(?<![没不未别莫])'

export const ATTRIBUTION_BEFORE = new RegExp(
  `([\\u4e00-\\u9fa5]{2,4})${NOT_NEGATED}(?:${SPEECH_VERBS})[：:]?\\s*[“「"]([^”」"\\n]{1,400})[”」"]`,
  'g',
)

/**
 * The trailing speaker must be on the same line as the closing quote. With
 * `\s*` the gap swallowed paragraph breaks, so `母亲说："你回来了。"` followed
 * two lines later by `林砚说：…` credited 母亲's line to 林砚.
 */
export const ATTRIBUTION_AFTER = new RegExp(
  `[“「"]([^”」"\\n]{1,400})[”」"][，,]?[ \\t]*([\\u4e00-\\u9fa5]{2,4})${NOT_NEGATED}(?:${SPEECH_VERBS})`,
  'g',
)
