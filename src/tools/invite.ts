import type { PhoneTool, ToolInput } from '../lib/tools';
import { t } from '../i18n';

/**
 * 找 Agent 一起討論：AI 照話題找人，畫面上出一張勾選卡（預設全勾、每位一句為什麼、可以換一批）。
 * 找人、加入、接著討論都由 chatStore 處理（要用到這段對話和模型），這裡只有給模型看的定義
 */
export function inviteAgentsTool(): PhoneTool {
  return {
    name: 'invite_agents',
    description:
      'Bring AI agents (people with different expertise and viewpoints) into this conversation so they discuss a topic together with the user. Use it when the user asks you to find, invite or bring in experts, agents or people to discuss something. The app finds suitable agents and lets the user pick them; do not name them yourself.',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: "What they should discuss, in the user's own words" } },
      required: ['topic'],
    },
    annotations: {},
    requiresUserInteraction: true,
    kind: 'agents',
    get label() {
      return t('找 Agent 一起討論');
    },
    run: async () => ({ data: {}, summary: '' }),
  };
}

/** 模型不會叫工具：使用者要找人時，請模型告訴他去哪裡按 */
export function inviteHintPrompt(): string {
  return `You cannot bring other agents into this chat yourself. Only if the user asks to find or invite agents or experts to discuss with, tell them to tap the title at the top, choose 「${t('成員與討論設定')}」, then 「${t('幫我挑')}」.`;
}

/** 勾選卡上的一位人選（存在確認動作的 input 裡：每個欄位一個清單，同一個位置是同一位） */
export type AgentCandidate = {
  /** mine:<Agent id> 是「我的 Agent」，catalog:<圖鑑 id> 是圖鑑 */
  key: string;
  name: string;
  intro: string;
  why: string;
  emoji: string;
  avatar: string;
};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export function candidatesToInput(c: AgentCandidate[]): ToolInput {
  return {
    keys: c.map((x) => x.key),
    names: c.map((x) => x.name),
    intros: c.map((x) => x.intro),
    whys: c.map((x) => x.why),
    emojis: c.map((x) => x.emoji),
    avatars: c.map((x) => x.avatar),
  };
}

export function candidatesOf(input: ToolInput): AgentCandidate[] {
  const keys = list(input.keys);
  const [names, intros, whys, emojis, avatars] = ['names', 'intros', 'whys', 'emojis', 'avatars'].map((k) => list(input[k]));
  return keys.map((key, i) => ({ key, name: names[i] ?? '', intro: intros[i] ?? '', why: whys[i] ?? '', emoji: emojis[i] ?? '', avatar: avatars[i] ?? key }));
}
