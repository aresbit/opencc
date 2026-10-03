// 英文非推荐词 → 推荐写法（取自 ASD-STE100 的精神：用短、常见、一词一义的词）。
export const EN_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'utilize': 'use', 'utilise': 'use', 'utilization': 'use', 'commence': 'start', 'commenced': 'started',
  'prior to': 'before', 'in order to': 'to', 'approximately': 'about', 'ensure': 'make sure',
  'replenish': 'fill', 'terminate': 'stop', 'facilitate': 'help', 'leverage': 'use', 'numerous': 'many',
  'subsequently': 'then', 'endeavor': 'try', 'ascertain': 'find', 'sufficient': 'enough',
  'demonstrate': 'show', 'assist': 'help', 'obtain': 'get', 'initiate': 'start', 'modify': 'change',
  'possess': 'have', 'purchase': 'buy', 'in the event that': 'if', 'due to the fact that': 'because',
  'at this point in time': 'now', 'a number of': 'some', 'with regard to': 'about', 'in addition': 'also',
});
