import type { PhoneTool } from '../lib/tools';
import { t } from '../i18n';

/** 問使用者選擇題（照 Claude Code 的 AskUserQuestion，配合小模型縮成一次一題、2～4 個選項、可以自己打字） */
export function askUserTool(): PhoneTool {
  return {
    name: 'ask_user',
    description:
      'Ask the user one multiple-choice question when something you need is unclear (for example which calendar, or what time). Give 2 to 4 short options. The user can also type their own answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      },
      required: ['question', 'options'],
    },
    annotations: { readOnlyHint: true },
    requiresUserInteraction: true,
    kind: 'question',
    get label() {
      return t('問你一個問題');
    },
    run: async (input) => {
      const answer = String(input.answer ?? '').trim();
      return { data: { answer }, summary: t('你回答：{p0}', { p0: answer }) };
    },
  };
}
