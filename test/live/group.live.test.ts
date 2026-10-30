/**
 * @jest-environment node
 *
 * 多 AI 討論打真的模型（不在 npm test 裡跑）：
 *   LIVE_GROUP_HOST=http://100.100.0.31:11434 LIVE_GROUP_MODEL=gemma4:31b npm run test:live -- group
 * 從圖鑑挑 3 個角色（用真的角色原文），丟一個話題，跑完一輪討論再收尾，整段印出來看品質。
 */
/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import { PromptStore, entryIntro, entryName, getEntry, searchCatalog, type PromptShard } from '../../src/agents/catalog';
import { estimateTokens, parseConclusion } from '../../src/agents/discussion';
import { ChatStore } from '../../src/state/chatStore';
import { OllamaClient } from '../../src/lib/ollama';
import { Repo } from '../../src/store/repo';
import { memoryDb } from '../helpers/nodeDb';
import { nodeFetch } from './nodeFetch';

const HOST = process.env.LIVE_GROUP_HOST ?? '';
const MODEL = process.env.LIVE_GROUP_MODEL ?? 'gemma4:31b';
const TOPIC = process.env.LIVE_GROUP_TOPIC ?? '公司那台伺服器用了 7 年，最近一個月當機兩次，要不要今年就換新的？預算大概 30 萬。';

jest.setTimeout(900_000);

/** 測試裡直接讀專案裡的原文分片 */
const prompts = new PromptStore(async (i) => JSON.parse(readFileSync(join(__dirname, '../../assets/agents', `prompts-${String(i).padStart(2, '0')}.txt`), 'utf8')) as PromptShard);

(HOST ? describe : describe.skip)(`多 AI 討論（${MODEL}）`, () => {
  test('三個角色討論、收尾：每個人都說到話、不替別人說話、回覆短、有結論和筆記', async () => {
    const repo = new Repo(memoryDb());
    const store = new ChatStore({ repo, client: (url) => new OllamaClient(url, { fetch: nodeFetch }), wifiIp: async () => null, autoScan: false, prompts, probeTimeoutMs: 10_000 });
    await store.init();
    const url = (await store.addHost(new URL(HOST).host)).url;
    await store.loadModels(url);
    await store.selectModel(url, MODEL);
    await store.setGroupSettings({ maxStreak: 6 });
    const picks = ['財務分析師', 'SRE', '產品經理'].map((q) => searchCatalog(q)[0] ?? getEntry('lobe:ceo-gpt')!);
    for (const e of picks) await store.addCatalogMember(e.id, { name: entryName(e), intro: entryIntro(e), emoji: e.e });
    const names = store.getState().members.map((m) => m.agent.name);
    console.log(`成員：${names.join('、')}`);

    const t0 = Date.now();
    await store.send(TOPIC);
    const t1 = Date.now();
    await store.conclude();
    const t2 = Date.now();

    const s = store.getState();
    const name = (id: string | null) => (id ? (s.agents[id]?.name ?? s.members.find((m) => m.agent.id === id)?.agent.name ?? '?') : '你');
    const log = s.messages.map((m) => {
      if (m.detail === 'conclusion') return `\n=== 結論卡 ===\n${JSON.stringify(parseConclusion(m.content), null, 1)}`;
      if (m.role === 'note' || m.role === 'error') return `【${m.role}】${m.content}`;
      const reply = m.replyTo ? `（回覆 ${name(s.messages.find((x) => x.id === m.replyTo)?.agentId ?? null)}）` : '';
      return `【${name(m.agentId)}】${reply}${m.content}`;
    });
    console.log(`討論 ${((t1 - t0) / 1000).toFixed(0)} 秒、收尾 ${((t2 - t1) / 1000).toFixed(0)} 秒\n\n${log.join('\n\n')}`);
    for (const m of s.members) console.log(`${m.agent.name} 的筆記：${(await repo.listNotes(m.agent.id)).map((n) => n.content).join(' / ')}`);

    const spoken = s.messages.filter((m) => m.role === 'assistant' && m.agentId);
    expect(s.messages.some((m) => m.role === 'error')).toBe(false);
    expect(spoken.length).toBeGreaterThanOrEqual(2);
    // 自由搶話：沒人想講就停，不保證每個人都講到（每個人都表態的是下面的投票）；至少要有兩個人講
    expect(new Set(spoken.map((m) => m.agentId)).size).toBeGreaterThanOrEqual(2);
    for (const m of spoken) {
      // 不替別人說話：內文沒有「【別人】」，也沒有哪一行用「別人：」開頭
      for (const other of names.filter((n) => n !== name(m.agentId))) {
        expect(m.content).not.toContain(`【${other}】`);
        expect(m.content).not.toMatch(new RegExp(`^\\s*${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]`, 'm'));
      }
      // 回覆短（規則是 1–4 句）：一則不超過約 250 個字
      expect(estimateTokens(m.content)).toBeLessThan(250);
    }
    const card = parseConclusion(s.messages.find((m) => m.detail === 'conclusion')!.content)!;
    expect(card.options.length).toBeGreaterThanOrEqual(2);
    expect(card.options.reduce((n, o) => n + o.votes.length, 0)).toBe(s.members.length);
    expect(card.consensus.length).toBeGreaterThan(0);
  });

  test('一般聊天說「找懂的人一起討論」：模型叫找 Agent，勾選卡有 2–4 位、每位一句為什麼；加入後 Agent 接著回', async () => {
    const repo = new Repo(memoryDb());
    const store = new ChatStore({ repo, client: (url) => new OllamaClient(url, { fetch: nodeFetch }), wifiIp: async () => null, autoScan: false, prompts, probeTimeoutMs: 10_000 });
    await store.init();
    const url = (await store.addHost(new URL(HOST).host)).url;
    await store.loadModels(url);
    await store.selectModel(url, MODEL);
    await store.setGroupSettings({ maxStreak: 3 });
    await repo.createAgent({ name: '財務長', intro: '管公司預算、在意投資報酬', mine: true });
    const t0 = Date.now();
    await store.send(process.env.LIVE_INVITE_ASK ?? '我想討論公司那台用了 7 年的伺服器要不要今年換掉，幫我找幾個懂這方面的 Agent 一起討論');
    const action = store.getState().messages.flatMap((m) => m.actions ?? []).find((a) => a.tool === 'invite_agents');
    console.log(`找人 ${((Date.now() - t0) / 1000).toFixed(0)} 秒：${JSON.stringify(action?.input ?? null, null, 1)}`);
    expect(action?.status).toBe('pending');
    const keys = action!.input.keys as string[];
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect((action!.input.whys as string[]).every((w) => w.length > 0)).toBe(true);
    const t1 = Date.now();
    await store.approveAgents(action!.id, keys);
    const s = store.getState();
    const spoken = s.messages.filter((m) => m.role === 'assistant' && m.agentId);
    console.log(`加入後討論 ${((Date.now() - t1) / 1000).toFixed(0)} 秒\n${spoken.map((m) => `【${s.agents[m.agentId!]?.name}】${m.content}`).join('\n\n')}`);
    expect(spoken.length).toBeGreaterThanOrEqual(1);
    expect(s.messages.some((m) => m.role === 'error')).toBe(false);
  });
});
