/**
 * Prompt surface for the discover_skills tool.
 *
 * This tool is registered unconditionally in `tools.ts`, NOT behind
 * `EXPERIMENTAL_SKILL_SEARCH` like the rest of `services/skillSearch/`. The
 * whole point of the audit that motivated it was that a producer whose
 * consumer is behind a dead flag is indistinguishable from no feature at all:
 * the index would be built and never read. So the tool that reads it is part
 * of the base tool set, and the constants here are real values rather than the
 * empty-string placeholders the decompiler left.
 *
 * The `feature()`-gated consumers in `constants/prompts.ts` are left as they
 * are. They inject a listing into the system prompt; this tool is the
 * model pulling on demand instead, which works with or without that flag.
 */

export const DISCOVER_SKILLS_TOOL_NAME = 'discover_skills'

export const DESCRIPTION =
  'Search your own skills and distilled lessons by meaning, not exact name. ' +
  'Ranks every installed skill and every lesson the agent has distilled using BM25 ' +
  'over their names, descriptions, when_to_use hints and lesson text, and returns ' +
  'the closest matches with scores.'

export function getPrompt(): string {
  return [
    'Use this tool when you are about to start a task and want to know whether you',
    'already have a skill or a hard-won lesson that applies — especially when the',
    'skill you need is not obvious from its name, or when you are unsure whether one',
    'exists. It searches skill names, descriptions and when_to_use hints together with',
    'the distilled lesson library, and ranks results by relevance rather than by name',
    'substring.',
    '',
    'Prefer this over guessing at a slash-command name. A match whose name you would',
    'not have thought to type is exactly the case this exists for.',
    '',
    'Arguments:',
    '- query (required): the situation or task, in your own words. Natural language',
    '  is fine; Chinese and English are both tokenised.',
    '- k (optional, default 5): how many matches to return.',
  ].join('\n')
}
