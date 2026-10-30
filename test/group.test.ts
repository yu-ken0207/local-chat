import { PromptStore, suggestAvatar } from '../src/agents/catalog';
import { ChatStore, ROLE_TRUNCATED } from '../src/state/chatStore';
import { DEFAULT_GROUP, Repo, type Agent } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 多 AI 討論：一段對話裡好幾個 Agent 自己搶話

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

/** 從系統提示詞認出是誰：舉手是「你是「X」：」，正式發言是「你是「X」，正在…」 */
const whoBids = (body: any) => /^你是「(.+?)」：/.exec(body.messages[0].content)?.[1] ?? '';
const whoSpeaks = (body: any) => /^你是「(.+?)」，正在/.exec(body.messages[0].content)?.[1] ?? '';
const done = { message: { content: '' }, done: true, eval_count: 5, prompt_eval_count: 50 };

/**
 * 劇本：bids[名字] 是每一輪舉手給的分數（用完就 0）；講話回「名字說第 n 次」。
 * conclude 列出舉手時說「可以收尾」的人
 */
function script(net: FakeOllamaNet, bids: Record<string, number[]>, opts: { conclude?: string[]; hold?: Promise<unknown>; hostPick?: string[] } = {}) {
  const host = net.hosts.get(A)!;
  const spoke: Record<string, number> = {};
  const hostPicks = [...(opts.hostPick ?? [])];
  host.reply = (body: any) => {
    if (body.format?.properties?.next) {
      return { lines: [{ message: { content: JSON.stringify({ next: hostPicks.shift() ?? '', reply_to: '', conclude: false }) }, done: false }, done] };
    }
    if (body.format) {
      const name = whoBids(body);
      const score = bids[name]?.shift() ?? 0;
      return { lines: [{ message: { content: JSON.stringify({ score, reply_to: '', conclude: opts.conclude?.includes(name) ?? false }) }, done: false }, done] };
    }
    const name = whoSpeaks(body);
    if (!name) return { lines: [{ message: { content: '摘要：大家在吵預算' }, done: false }, done] };
    spoke[name] = (spoke[name] ?? 0) + 1;
    return { lines: [{ message: { content: `${name}說第${spoke[name]}次` }, done: false }, done], holdLast: opts.hold };
  };
  return spoke;
}

async function setup(opts: { members?: string[]; prompts?: PromptStore; runtimeCtx?: number } = {}) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }], runtimeCtx: opts.runtimeCtx ?? 8192 });
  const repo = new Repo(memoryDb());
  const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false, prompts: opts.prompts });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  const agents: Record<string, Agent> = {};
  for (const name of opts.members ?? ['財務長', '工程師']) {
    agents[name] = await repo.createAgent({ name, intro: `${name}的介紹`, card: { expertise: `${name}的專長`, stance: '', style: '', blindSpot: '' }, mine: true });
    await store.addMember(agents[name].id);
  }
  return { net, repo, store, agents };
}

const said = (store: ChatStore) =>
  store
    .getState()
    .messages.filter((m) => m.role === 'assistant' || m.role === 'user' || m.role === 'error')
    .map((m) => (m.role === 'user' ? `你：${m.content}` : m.role === 'error' ? `錯誤：${m.content}` : `${store.getState().agents[m.agentId!]?.name}：${m.content}`));

test('自由搶話：分數最高的講、回你；剛講完的扣分換人；都不想講就停', async () => {
  const { net, store, agents } = await setup();
  script(net, { 財務長: [8, 2, 1], 工程師: [3, 7, 2] });
  await store.send('要不要換新伺服器？');
  expect(said(store)).toEqual(['你：要不要換新伺服器？', '財務長：財務長說第1次', '工程師：工程師說第1次']);
  const [q, a] = store.getState().messages;
  expect(a).toMatchObject({ agentId: agents['財務長'].id, replyTo: q.id });
  // 舉手不帶角色設定（才快）；正式發言帶群組規則與角色卡
  const bid = net.chatBodies().find((b) => b.format)!;
  expect(bid.messages[0].content).not.toContain('財務長的專長');
  expect(bid.options).toMatchObject({ num_predict: 80 });
  const speech = net.chatBodies().find((b) => !b.format && whoSpeaks(b) === '財務長')!;
  expect(speech.messages[0].content).toContain('1–4 句');
  expect(speech.messages[0].content).toContain('專長：財務長的專長');
  expect(speech.messages.at(-1)).toEqual({ role: 'system', content: '現在輪到你（財務長）發言，回應【使用者】。直接說你要說的話。' });
  expect(store.getState().running).toEqual({});
  expect(store.getState().discussion).toBeNull();
});

test('你說話一定有人回：大家都沒到門檻，最高分的成員還是回你一次', async () => {
  const { net, store } = await setup();
  script(net, { 財務長: [2], 工程師: [4] });
  await store.send('嗨');
  expect(said(store)).toEqual(['你：嗨', '工程師：工程師說第1次']);
});

test('@ 到的人直接講（不用舉手）；@「我的 Agent」裡還不是成員的會被拉進來', async () => {
  const { net, repo, store } = await setup();
  const pm = await repo.createAgent({ name: '產品經理', intro: '顧使用者', mine: true });
  script(net, {});
  await store.send('@工程師 你覺得呢');
  expect(said(store)).toEqual(['你：@工程師 你覺得呢', '工程師：工程師說第1次']);
  expect(net.chatBodies()[0].format).toBeUndefined();
  await store.send('@產品經理 也說說');
  expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長', '工程師', '產品經理']);
  expect(store.getState().messages.some((m) => m.role === 'note' && m.content === '產品經理 加入了討論')).toBe(true);
  expect(said(store).at(-1)).toBe('產品經理：產品經理說第1次');
  expect(pm.id).toBe(store.getState().members[2].agent.id);
});

test('連續上限：講滿就停下等你；過半覺得可以收尾就提議', async () => {
  const { net, store } = await setup();
  await store.setGroupSettings({ maxStreak: 3 });
  script(net, { 財務長: [9, 9, 9, 9], 工程師: [9, 9, 9, 9] }, { conclude: ['財務長', '工程師'] });
  await store.send('開始');
  expect(said(store)).toHaveLength(4);
  expect(store.getState().suggestConclude).toEqual([store.getState().session!.id]);
  store.dismissConclude();
  expect(store.getState().suggestConclude).toEqual([]);
});

test('討論中插話：馬上送出（不用等），有人回你的新訊息', async () => {
  const { net, store } = await setup();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  script(net, { 財務長: [8, 0, 0], 工程師: [0, 6, 0] }, { hold });
  const first = store.send('要換伺服器嗎');
  await new Promise((r) => setTimeout(r, 50));
  expect(store.getState().discussion).toEqual({ phase: 'speaking', agentId: expect.any(String) });
  await store.send('預算只有 10 萬');
  release();
  await first;
  expect(said(store)).toEqual(['你：要換伺服器嗎', '財務長：財務長說第1次', '你：預算只有 10 萬', '工程師：工程師說第1次']);
});

test('暫停：講到一半停掉，記「已停止」，討論結束；再按繼續就接著聊', async () => {
  const { net, store } = await setup();
  const host = net.hosts.get(A)!;
  host.reply = (body: any) =>
    body.format
      ? { lines: [{ message: { content: '{"score":9,"reply_to":"","conclude":false}' }, done: false }, done] }
      : { lines: [{ message: { content: '講到一半' }, done: false }], hang: true };
  const p = store.send('開始');
  await new Promise((r) => setTimeout(r, 80));
  store.stop();
  await p;
  const msgs = store.getState().messages;
  expect(msgs.at(-1)).toMatchObject({ role: 'note', content: '已停止' });
  expect(msgs.at(-2)).toMatchObject({ role: 'assistant', content: '講到一半' });
  expect(store.getState().running).toEqual({});
  script(net, { 財務長: [0, 0], 工程師: [6, 0] });
  await store.continueDiscussion();
  expect(said(store).at(-1)).toBe('工程師：工程師說第1次');
});

test('輪流：每個人照順序講一次就停', async () => {
  const { net, store } = await setup({ members: ['甲', '乙', '丙'] });
  await store.setGroupSettings({ mode: 'round' });
  script(net, {});
  await store.send('輪流講');
  expect(said(store)).toEqual(['你：輪流講', '甲：甲說第1次', '乙：乙說第1次', '丙：丙說第1次']);
  expect(net.chatBodies().some((b) => b.format)).toBe(false);
});

test('主持人點名：照主持人選的人講，主持人說不用了就停', async () => {
  const { net, store } = await setup();
  await store.setGroupSettings({ mode: 'host' });
  script(net, {}, { hostPick: ['工程師', '財務長', ''] });
  await store.send('誰先說');
  expect(said(store)).toEqual(['你：誰先說', '工程師：工程師說第1次', '財務長：財務長說第1次']);
});

test('只回被 @ 的：沒 @ 時最近講話的回你一次', async () => {
  const { net, store } = await setup();
  await store.setGroupSettings({ mode: 'mention' });
  script(net, {});
  await store.send('@財務長 你先');
  await store.send('那大家呢');
  expect(said(store)).toEqual(['你：@財務長 你先', '財務長：財務長說第1次', '你：那大家呢', '財務長：財務長說第2次']);
});

test('讓 AI 自己加入：勾了「可以自己加入」的高分就加入討論', async () => {
  const { net, repo, store } = await setup();
  await repo.createAgent({ name: '律師', intro: '看合約', mine: true, autoJoin: true });
  await repo.createAgent({ name: '沒勾的', intro: '路過', mine: true });
  await store.setGroupSettings({ autoJoin: true });
  script(net, { 財務長: [6, 0], 工程師: [0, 0], 律師: [8, 0], 沒勾的: [10] });
  await store.send('合約要注意什麼');
  expect(said(store)).toEqual(['你：合約要注意什麼', '律師：律師說第1次']);
  expect(store.getState().members.map((m) => [m.agent.name, m.joinedBy])).toEqual([
    ['財務長', 'user'],
    ['工程師', 'user'],
    ['律師', 'auto'],
  ]);
  expect(net.chatBodies().filter((b) => b.format).map(whoBids)).not.toContain('沒勾的');
});

test('電腦連不到：說原因，不要默默停下來', async () => {
  const { net, store } = await setup();
  net.hosts.get(A)!.online = false;
  await store.send('嗨');
  expect(said(store).at(-1)).toMatch(/^錯誤：沒有得到回答/);
  expect(store.getState().running).toEqual({});
});

test('請他展開講：同一個人完整說明那一則，只講這一次', async () => {
  const { net, store } = await setup();
  script(net, { 財務長: [8, 0], 工程師: [0, 0] });
  await store.send('預算夠嗎');
  const target = store.getState().messages.at(-1)!;
  await store.expandMessage(target.id);
  const last = store.getState().messages.at(-1)!;
  expect(last).toMatchObject({ agentId: target.agentId, replyTo: target.id, content: '財務長說第2次' });
  const body = net.chatBodies().at(-1)!;
  expect(body.messages[0].content).toContain('不限長度');
});

test('重新產生某個 Agent 說的：同一個人再講一次，舊的變成版本', async () => {
  const { net, store } = await setup();
  script(net, { 財務長: [8, 0], 工程師: [0, 0] });
  await store.send('預算夠嗎');
  const old = store.getState().messages.at(-1)!;
  await store.regenerate(old.id);
  const now = store.getState().messages.at(-1)!;
  expect(now).toMatchObject({ agentId: old.agentId, content: '財務長說第2次', versions: { index: 2, total: 2 } });
});

test('圖鑑的 Agent：用圖鑑原文當角色說明；上下文太小就截短並註明', async () => {
  const prompts = new PromptStore(async () => ({ 'lobe:chef': { zh: '你是大廚。\n\n' + '火候很重要。'.repeat(800) } }));
  const { net, repo, store } = await setup({ members: [], prompts, runtimeCtx: 2048 });
  const chef = await repo.agentFromCatalog('lobe:chef', { name: '大廚', intro: '會做菜', emoji: '👨‍🍳' });
  await store.addMember(chef.id);
  script(net, {});
  await store.send('今晚吃什麼');
  const speech = net.chatBodies().find((b) => whoSpeaks(b) === '大廚')!;
  expect(speech.messages[0].content).toContain('你是大廚。');
  expect(speech.messages[0].content).toMatch(/以下省略/);
  expect(store.getState().messages.at(-1)).toMatchObject({ detail: ROLE_TRUNCATED, content: '大廚說第1次' });
});

test('對話太長：前面的併進前情摘要，之後只送摘要和最近的', async () => {
  const { net, repo, store } = await setup({ members: ['財務長'], runtimeCtx: 2048 });
  const s = store.getState().session!;
  for (let i = 0; i < 40; i++) await repo.addMessage(s.id, { role: i % 2 ? 'assistant' : 'user', content: `第${i}句`.padEnd(80, '。') });
  await store.openSession((await repo.createSession()).id);
  await store.openSession(s.id);
  script(net, {});
  await store.send('最後一句');
  const after = (await repo.getSession(s.id))!;
  expect(after.summary).toBe('摘要：大家在吵預算');
  expect(after.summarySeq).toBeGreaterThan(0);
  const speech = net.chatBodies().find((b) => whoSpeaks(b) === '財務長')!;
  expect(speech.messages[1]).toEqual({ role: 'system', content: '前情摘要（之前的討論）：\n摘要：大家在吵預算' });
  expect(JSON.stringify(speech.messages)).not.toContain('第0句');
  expect(said(store).at(-1)).toBe('財務長：財務長說第1次');
});

test('換到別段對話：討論在背景繼續；回來看得到成員和結果', async () => {
  const { net, store } = await setup();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  script(net, { 財務長: [8, 0], 工程師: [0, 0] }, { hold });
  const s = store.getState().session!;
  const p = store.send('換伺服器嗎');
  await new Promise((r) => setTimeout(r, 50));
  await store.newSession();
  expect(store.getState().members).toEqual([]);
  expect(store.getState().running).toHaveProperty(s.id);
  release();
  await p;
  await store.openSession(s.id);
  await store.groupTask;
  expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長', '工程師']);
  expect(said(store)).toEqual(['你：換伺服器嗎', '財務長：財務長說第1次']);
});

test('群組設定：存在對話上，沒改過照預設', async () => {
  const { store } = await setup();
  expect(store.getState().session!.group).toBeNull();
  await store.setGroupSettings({ autopilot: true });
  expect(store.getState().session!.group).toEqual({ ...DEFAULT_GROUP, autopilot: true });
});

describe('Agent（設定頁）', () => {
  test('一句話生成角色卡；再生一個時告訴模型上一個是誰；存進「我的 Agent」', async () => {
    const { net, store } = await setup({ members: [] });
    const host = net.hosts.get(A)!;
    const draft = { name: '挑剔財務長', intro: '每筆錢都要問清楚', expertise: '預算', stance: '保守', style: '直接', blindSpot: '忽略長期價值', emoji: '💼', talk: 0.7 };
    host.reply = (body: any) => ({ lines: [{ message: { content: JSON.stringify(draft) }, done: false }, done] });
    const got = await store.generateAgent('一個愛挑毛病的財務長');
    // 頭像：圖鑑裡名字或專長最接近的角色
    const avatar = suggestAvatar('挑剔財務長', ['預算']);
    expect(avatar).not.toBeNull();
    expect(got).toEqual({ avatar, name: '挑剔財務長', intro: '每筆錢都要問清楚', emoji: '💼', talk: 0.7, card: { expertise: '預算', stance: '保守', style: '直接', blindSpot: '忽略長期價值' } });
    expect(net.chatBodies().at(-1).format.required).toContain('blindSpot');
    await store.generateAgent('一個愛挑毛病的財務長', '挑剔財務長');
    expect(net.chatBodies().at(-1).messages[1].content).toContain('上一個生成的是「挑剔財務長」');
    const saved = await store.saveAgent(got);
    expect(store.getState().myAgents.map((a) => a.name)).toEqual(['挑剔財務長']);
    await store.saveAgent({ name: '財務長', talk: 0.2 }, saved.id);
    expect(store.getState().myAgents.map((a) => [a.name, a.talk])).toEqual([['財務長', 0.2]]);
  });

  test('模型回的不是角色：說清楚要換個說法', async () => {
    const { net, store } = await setup({ members: [] });
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '我不知道' }, done: false }, done] });
    await expect(store.generateAgent('???')).rejects.toThrow('換個說法');
  });

  test('圖鑑加到「我的 Agent」：名字介紹照圖鑑；再加一次還是同一份', async () => {
    const { store } = await setup({ members: [] });
    const a = await store.addCatalogToMine('lobe:chef');
    const b = await store.addCatalogToMine('lobe:chef');
    expect(b!.id).toBe(a!.id);
    expect(store.getState().myAgents.map((x) => [x.catalogId, x.emoji])).toEqual([['lobe:chef', a!.emoji]]);
    expect(await store.addCatalogToMine('lobe:nope')).toBeNull();
  });

  test('刪掉 Agent 可以復原；筆記可以看、刪、清空', async () => {
    const { repo, store, agents } = await setup();
    const cfo = agents['財務長'];
    await repo.addNote(cfo.id, null, '一');
    const n2 = await repo.addNote(cfo.id, null, '二');
    await store.deleteNote(n2.id);
    expect((await store.listNotes(cfo.id)).map((n) => n.content)).toEqual(['一']);
    await store.clearNotes(cfo.id);
    expect(await store.listNotes(cfo.id)).toEqual([]);
    await store.loadMyAgents();
    await store.deleteAgent(cfo.id);
    expect(store.getState().myAgents.map((a) => a.name)).toEqual(['工程師']);
    expect(store.getState().undo?.message).toBe('已刪除「財務長」');
    await store.undoLast();
    expect(store.getState().myAgents.map((a) => a.name).sort()).toEqual(['工程師', '財務長'].sort());
  });
});

describe('收尾', () => {
  /** 收尾的劇本：列方案、投票（照名字）、結論卡、筆記 */
  function concludeScript(net: FakeOllamaNet, votes: Record<string, number>) {
    net.hosts.get(A)!.reply = (body: any) => {
      const sys: string = body.messages[0].content;
      const reply = (content: string) => ({ lines: [{ message: { content }, done: false }, done] });
      if (body.format?.properties?.options) return reply(JSON.stringify({ question: '要不要換伺服器？', options: ['今年換', '先修再說'] }));
      if (body.format?.properties?.choice) {
        const name = /^你是「(.+?)」：/.exec(sys)![1];
        return reply(JSON.stringify({ choice: votes[name], reason: `${name}的理由` }));
      }
      if (body.format?.properties?.consensus) return reply(JSON.stringify({ consensus: '先修再說，明年再評估', disagreements: ['預算要不要先保留'], todos: ['找廠商估修理費'] }));
      if (body.format) return reply('{"score":0,"reply_to":"","conclude":false}');
      if (sys.includes('這次討論結束了')) return reply(`${/^你是「(.+?)」：/.exec(sys)![1]}：這次主張先修`);
      return reply(`${whoSpeaks(body)}說了話`);
    };
  }

  test('列方案、每個人投票附理由、寫結論卡並釘在最上面；每個人寫筆記', async () => {
    const { net, repo, store, agents } = await setup();
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('要換伺服器嗎');
    concludeScript(net, { 財務長: 2, 工程師: 1 });
    await store.conclude();
    const card = store.getState().messages.at(-1)!;
    expect(card).toMatchObject({ role: 'note', detail: 'conclusion' });
    expect(JSON.parse(card.content)).toEqual({
      question: '要不要換伺服器？',
      options: [
        { text: '今年換', votes: [{ who: agents['工程師'].id, name: '工程師', reason: '工程師的理由' }] },
        { text: '先修再說', votes: [{ who: agents['財務長'].id, name: '財務長', reason: '財務長的理由' }] },
      ],
      consensus: '先修再說，明年再評估',
      disagreements: ['預算要不要先保留'],
      todos: ['找廠商估修理費'],
    });
    expect(store.getState().session!.pinnedId).toBe(card.id);
    expect((await repo.listNotes(agents['財務長'].id)).map((n) => n.content)).toEqual(['財務長：這次主張先修']);
    expect(store.getState().running).toEqual({});
    // 你補投一票；再投是換票
    await store.voteConclusion(card.id, 0);
    await store.voteConclusion(card.id, 1);
    const after = JSON.parse(store.getState().messages.at(-1)!.content);
    expect(after.options.map((o: any) => o.votes.map((v: any) => v.name))).toEqual([['工程師'], ['財務長', '你']]);
    await store.pinConclusion(null);
    expect(store.getState().session!.pinnedId).toBeNull();
  });

  test('之後接著討論：大家看得到結論', async () => {
    const { net, store } = await setup();
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('要換伺服器嗎');
    concludeScript(net, { 財務長: 2, 工程師: 2 });
    await store.conclude();
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('那預算呢');
    const speech = net.chatBodies().filter((b) => whoSpeaks(b) === '財務長').at(-1)!;
    expect(JSON.stringify(speech.messages)).toContain('【結論】先修再說，明年再評估');
  });

  test('全自動：聊到沒人想講就自己收尾', async () => {
    const { net, store } = await setup();
    await store.setGroupSettings({ autopilot: true });
    let phase = 'discuss';
    const bids = { 財務長: [8, 0], 工程師: [0, 0] } as Record<string, number[]>;
    net.hosts.get(A)!.reply = (body: any) => {
      if (body.format?.properties?.score && phase === 'discuss') {
        const name = /^你是「(.+?)」：/.exec(body.messages[0].content)![1];
        return { lines: [{ message: { content: JSON.stringify({ score: bids[name].shift() ?? 0, reply_to: '', conclude: false }) }, done: false }, done] };
      }
      if (!body.format && whoSpeaks(body)) return { lines: [{ message: { content: '講完了' }, done: false }, done] };
      phase = 'conclude';
      concludeScript(net, { 財務長: 1, 工程師: 1 });
      return net.hosts.get(A)!.reply!(body);
    };
    await store.send('開始');
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'note', detail: 'conclusion' });
  });

  test('收尾中暫停：記「已停止」，沒有結論卡', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '{' }, done: false }], hang: true });
    const p = store.conclude();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getState().discussion).toEqual({ phase: 'concluding', agentId: null });
    store.stop();
    await p;
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'note', content: '已停止' });
  });
});

test('多 AI 討論裡開討論串：沿用成員，帶進去的是那一題和那一輪每個人說的；在討論串裡照樣討論', async () => {
  const { net, repo, store, agents } = await setup();
  script(net, { 財務長: [8, 0, 0], 工程師: [0, 7, 0] });
  await store.send('要換伺服器嗎');
  const parent = store.getState().session!;
  const [q] = store.getState().messages;
  await store.openThread(q.id);
  const thread = store.getState().session!;
  expect(thread.parentId).toBe(parent.id);
  await store.groupTask;
  expect(store.getState().members.map((m) => [m.agent.name, m.joinedBy])).toEqual([
    ['財務長', 'thread'],
    ['工程師', 'thread'],
  ]);
  expect(store.getState().messages.map((m) => [m.detail, m.agentId])).toEqual([
    ['thread-root', null],
    ['thread-root', agents['財務長'].id],
    ['thread-root', agents['工程師'].id],
  ]);
  script(net, { 財務長: [0, 0], 工程師: [8, 0] });
  await store.send('那預算呢');
  expect(store.getState().messages.at(-1)).toMatchObject({ agentId: agents['工程師'].id, content: '工程師說第1次' });
  // 原對話的成員不受影響
  expect((await repo.listMembers(parent.id)).map((m) => m.joinedBy)).toEqual(['user', 'user']);
});

test('Agent 之間互 @ 只加分不強制：兩個人互 @ 時，第三個人也輪得到（iPhone 實測 SRE 和產品經理一直互傳）', async () => {
  const { net, store } = await setup({ members: ['SRE', '產品經理', '財務'] });
  await store.setGroupSettings({ maxStreak: 4 });
  const host = net.hosts.get(A)!;
  const said: string[] = [];
  host.reply = (body: any) => {
    // 大家都很想講（31B 實測常這樣）
    if (body.format) return { lines: [{ message: { content: '{"score":8,"reply_to":"","conclude":false}' }, done: false }, done] };
    const name = whoSpeaks(body);
    said.push(name);
    const other = name === 'SRE' ? '產品經理' : 'SRE';
    return { lines: [{ message: { content: `@${other} 你看呢？` }, done: false }, done] };
  };
  // 你 @ 的一定先講
  await store.send('@SRE 要換伺服器嗎');
  expect(said.slice(0, 3)).toEqual(['SRE', '產品經理', '財務']);
});
