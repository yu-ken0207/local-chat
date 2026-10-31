import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS } from 'react-native';

import { getEntry } from '../src/agents/catalog';
import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo, type Agent } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 找 Agent 一起討論：一般聊天裡說「找懂的人來討論」，AI 叫工具、出勾選卡；一般聊天也能 @ 拉人；討論串有自己的成員

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

const done = { message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 50 };
const say = (content: string) => ({ lines: [{ message: { role: 'assistant', content }, done: false }, done] });
const whoBids = (body: any) => /^你是「(.+?)」：/.exec(body.messages[0].content)?.[1] ?? '';
const whoSpeaks = (body: any) => /^你是「(.+?)」，正在/.exec(body.messages[0].content)?.[1] ?? '';
const hist = getEntry('agency:academic/academic-historian')!;

/**
 * 劇本：一般聊天第一次回答叫 invite_agents，之後照常回答「AI 自己回答」；
 * 找人時先想角色（roles 依序用，沒給就是歷史學家），再從名單挑（picks 依序用）；舉手 bids；Agent 講話回「名字說了」
 */
const HISTORIAN = { zh: '歷史學家', en: 'Historian', keywords: ['歷史'] };
function script(net: FakeOllamaNet, opts: { roles?: object[][]; picks?: object[][]; bids?: Record<string, number[]>; invite?: boolean } = {}) {
  const roles = [...(opts.roles ?? [])];
  const batches = [...(opts.picks ?? [])];
  let called = false;
  net.hosts.get(A)!.reply = (body: any) => {
    if (body.format?.properties?.roles) return say(JSON.stringify({ roles: roles.shift() ?? [HISTORIAN] }));
    if (body.format?.properties?.picks) return say(JSON.stringify({ picks: batches.shift() ?? [] }));
    if (body.format) return say(JSON.stringify({ score: opts.bids?.[whoBids(body)]?.shift() ?? 0, reply_to: '', conclude: false }));
    if (whoSpeaks(body)) return say(`${whoSpeaks(body)}說了`);
    if (opts.invite !== false && !called && body.tools?.some((x: any) => x.function.name === 'invite_agents')) {
      called = true;
      return { lines: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'invite_agents', arguments: { topic: '要不要換伺服器' } } }] }, done: false }, done] };
    }
    return say('AI 自己回答');
  };
}

async function setup(model = { name: 'gemma4:31b', tools: true }) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [model] });
  const repo = new Repo(memoryDb());
  const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, model.name);
  const cfo: Agent = await repo.createAgent({ name: '財務長', intro: '看預算', mine: true });
  return { net, repo, store, cfo };
}

const said = (store: ChatStore) =>
  store
    .getState()
    .messages.filter((m) => (m.role === 'assistant' && m.content) || m.role === 'user')
    .map((m) => (m.role === 'user' ? `你：${m.content}` : `${m.agentId ? store.getState().agents[m.agentId]?.name : 'AI'}：${m.content}`));

describe('找 Agent 一起討論', () => {
  test('AI 叫工具：出勾選卡（我的 Agent 優先、每位一句為什麼）；勾了加入，原本的 AI 退場，Agent 接著回你那句', async () => {
    const { net, store, cfo } = await setup();
    script(net, { picks: [[{ name: '財務長', why: '管預算' }, { name: hist.n[0], why: '看過去的經驗' }]], bids: { 財務長: [8, 0], [hist.n[0]]: [0, 0] } });
    await store.send('我想討論要不要換伺服器，找懂的人一起討論');
    const action = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    expect(action).toMatchObject({ tool: 'invite_agents', status: 'pending' });
    expect(action.input).toMatchObject({ keys: [`mine:${cfo.id}`, `catalog:${hist.id}`], names: ['財務長', hist.n[0]], whys: ['管預算', '看過去的經驗'] });
    // 挑人的名單：「我的 Agent」在前面、標出來；圖鑑照角色撈到的也在裡面；只能挑名單裡的名字
    const choose = net.chatBodies().find((b) => b.format?.properties?.picks);
    expect(choose.messages[0].content).toContain('- 財務長（你的 Agent）：看預算');
    expect(choose.messages[0].content).toContain(`- ${hist.n[0]}：`);
    expect(choose.format.properties.picks.items.properties.name.enum).toEqual(expect.arrayContaining(['財務長', hist.n[0]]));
    await store.approveAgents(action.id, action.input.keys as string[]);
    expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長', hist.n[0]]);
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])[0]).toMatchObject({ status: 'done', summary: `邀請了 財務長、${hist.n[0]} 一起討論` });
    expect(said(store)).toEqual(['你：我想討論要不要換伺服器，找懂的人一起討論', '財務長：財務長說了']);
    const ask = store.getState().messages[0];
    expect(store.getState().messages.at(-1)!.replyTo).toBe(ask.id);
  });

  test('只勾一位：只加那一位', async () => {
    const { net, store, cfo } = await setup();
    script(net, { picks: [[{ name: '財務長', why: '管預算' }, { name: hist.n[0], why: '看過去' }]], bids: { 財務長: [8, 0] } });
    await store.send('找人討論要不要換伺服器');
    const action = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    await store.approveAgents(action.id, [`mine:${cfo.id}`]);
    expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長']);
  });

  test('按「不用了」：AI 照一般聊天自己回答，不會說「沒有做」', async () => {
    const { net, store } = await setup();
    script(net, { picks: [[{ name: hist.n[0], why: '看過去' }]] });
    await store.send('找人討論要不要換伺服器');
    const action = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    await store.declineAction(action.id);
    expect(said(store).at(-1)).toBe('AI：AI 自己回答');
    expect(store.getState().members).toEqual([]);
    const last = net.chatBodies().at(-1);
    expect(last.messages.at(-1).content).toContain('chose not to bring in other agents');
    expect(JSON.stringify(last.messages)).not.toContain('NOT done');
  });

  test('換一批：看過的不放進名單；找不到別人就說一聲，卡片照舊', async () => {
    const { net, store } = await setup();
    const STAT = { zh: '統計學家', en: 'Statistician', keywords: ['統計'] };
    script(net, { roles: [[HISTORIAN], [HISTORIAN, STAT], [HISTORIAN, STAT]], picks: [[{ name: hist.n[0], why: '看過去' }], [{ name: '統計學家', why: '看數字' }], []] });
    await store.send('找人討論要不要換伺服器');
    const id = store.getState().messages.flatMap((m) => m.actions ?? [])[0].id;
    await store.moreAgents(id);
    const after = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    expect(after.input.names).not.toContain(hist.n[0]);
    expect((after.input.names as string[]).length).toBe(1);
    expect(net.chatBodies().filter((b) => b.format?.properties?.picks).at(-1).messages[0].content).not.toContain(`- ${hist.n[0]}：`);
    await store.moreAgents(id);
    expect(store.getState().notice).toBe('沒有找到其他人選了。');
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])[0].input.names).toEqual(after.input.names);
  });

  test('找不到合適的人：不出卡片，AI 自己回答', async () => {
    const { net, store } = await setup();
    script(net, { picks: [[]] });
    await store.send('找人討論');
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])).toEqual([]);
    expect(said(store).at(-1)).toBe('AI：AI 自己回答');
  });

  test('不會叫工具的模型：系統提示詞說要找人去哪裡按', async () => {
    const { net, store } = await setup({ name: 'llama3:latest', tools: false });
    script(net, {});
    await store.send('找人討論');
    expect(net.chatBodies()[0].tools).toBeUndefined();
    expect(net.chatBodies()[0].messages[0].content).toContain('「成員與討論設定」, then 「幫我挑」');
  });

  test('「幫我挑」也是我的 Agent 優先', async () => {
    const { net, store } = await setup();
    script(net, { picks: [[{ name: '財務長', why: '管預算' }, { name: hist.n[0], why: '看過去' }]] });
    const picks = await store.suggestMembers('要不要換伺服器');
    expect(picks.map((c) => [c.name, c.why])).toEqual([
      ['財務長', '管預算'],
      [hist.n[0], '看過去'],
    ]);
  });
});

describe('一般聊天 @ 我的 Agent', () => {
  test('一般聊天打 @財務長：拉進來變成多人討論，由他回答（原本的 AI 不答）', async () => {
    const { net, store } = await setup();
    script(net, { invite: false });
    await store.send('先問 AI');
    await store.send('@財務長 你覺得預算夠嗎');
    expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長']);
    expect(said(store)).toEqual(['你：先問 AI', 'AI：AI 自己回答', '你：@財務長 你覺得預算夠嗎', '財務長：財務長說了']);
    expect(store.getState().messages.some((m) => m.content === '財務長 加入了討論')).toBe(true);
  });
});

describe('討論串有自己的成員', () => {
  test('一般聊天開討論串、在討論串邀請 Agent：原對話還是一般聊天', async () => {
    const { net, repo, store, cfo } = await setup();
    script(net, { invite: false });
    await store.send('要換伺服器嗎');
    const parent = store.getState().session!;
    await store.openThread(store.getState().messages[0].id);
    expect(store.getState().members).toEqual([]);
    await store.addMember(cfo.id);
    await store.send('那預算呢');
    expect(said(store).at(-1)).toBe('財務長：財務長說了');
    expect(await repo.listMembers(parent.id)).toEqual([]);
  });
});

describe('畫面', () => {
  const screenOf = (store: ChatStore) => render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  afterEach(() => jest.restoreAllMocks());

  test('勾選卡：預設全勾、每位一句為什麼；取消勾一位再按「加入並開始」，討論用氣泡接著進行', async () => {
    const { net, store } = await setup();
    script(net, { picks: [[{ name: '財務長', why: '管預算' }, { name: hist.n[0], why: '看過去的經驗' }]], bids: { 財務長: [8, 0] } });
    await screenOf(store);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '找人討論要不要換伺服器');
    await fireEvent.press(screen.getByLabelText('送出'));
    expect(await screen.findByText('找了這幾位一起討論')).toBeTruthy();
    expect(screen.getByLabelText('財務長，管預算').props.accessibilityState).toMatchObject({ checked: true });
    await fireEvent.press(screen.getByLabelText(`${hist.n[0]}，看過去的經驗`));
    expect(screen.getByLabelText(`${hist.n[0]}，看過去的經驗`).props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(screen.getByText('加入並開始'));
    expect(await screen.findByText('財務長說了')).toBeTruthy();
    expect(screen.getByText('邀請了 財務長 一起討論')).toBeTruthy();
    expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長']);
    expect(await screen.findByText('1 位成員')).toBeTruthy();
  });

  test('一般聊天打 @ 也跳出「我的 Agent」名單', async () => {
    const { net, store } = await setup();
    script(net, { invite: false });
    await screenOf(store);
    await waitFor(() => expect(store.getState().myAgents.length).toBe(1));
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '@財');
    expect(await screen.findByLabelText('提到 財務長')).toBeTruthy();
  });

  test('討論串的標題選單有「成員與討論設定」，可以在這裡邀請 Agent', async () => {
    const { net, store } = await setup();
    script(net, { invite: false });
    await store.send('要換伺服器嗎');
    await screenOf(store);
    await act(async () => {
      await store.openThread(store.getState().messages[0].id);
    });
    const seen: string[][] = [];
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => {
      seen.push(o.options);
      cb(0);
    });
    await fireEvent.press(await screen.findByLabelText('討論串，點一下可以邀請 Agent 或刪除'));
    expect(seen[0]).toEqual(['成員與討論設定', '刪除這個討論串', '取消']);
    // 成員面板蓋在卡片上（卡片是讀螢幕範圍，測試預設略過它旁邊的東西）
    expect(await screen.findByText('幫我挑', { includeHiddenElements: true })).toBeTruthy();
  });
});

describe('審查修正（完整 code review）：資料卡與找 Agent', () => {
  test('找 Agent 加進來、後來離開的人：打 @ 他也拉得回來（他不在「我的 Agent」）', async () => {
    const { net, store } = await setup();
    script(net, { picks: [[{ name: hist.n[0], why: '看過去' }]], bids: { [hist.n[0]]: [8, 0, 0] } });
    await store.send('找人討論要不要換伺服器');
    const action = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    await store.approveAgents(action.id, action.input.keys as string[]);
    const histId = store.getState().members[0].agent.id;
    expect(store.getState().myAgents.some((a) => a.id === histId)).toBe(false);
    await store.removeMember(histId);
    expect(store.getState().members).toEqual([]);
    await store.send(`@${hist.n[0]} 你再說說`);
    expect(store.getState().members.map((m) => m.agent.id)).toEqual([histId]);
    expect(said(store).at(-1)).toBe(`${hist.n[0]}：${hist.n[0]}說了`);
  });

  test('刪掉的 Agent 不能收進「我的 Agent」（編輯面板才不會變成建立）', async () => {
    const { repo, store, cfo } = await setup();
    await repo.deleteAgent(cfo.id);
    await store.makeMine(cfo.id);
    expect((await repo.getAgent(cfo.id))!.mine).toBe(false);
  });

  test('找人時按停止：那次叫工具照樣留下結果（不會留一個沒有回應的工具呼叫）', async () => {
    const { net, store } = await setup();
    let called = false;
    net.hosts.get(A)!.reply = (body: any) => {
      if (body.format?.properties?.roles) return { lines: [{ message: { role: 'assistant', content: '{' }, done: false }], hang: true };
      if (!called && body.tools) {
        called = true;
        return { lines: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'invite_agents', arguments: { topic: '換伺服器' } } }] }, done: false }, done] };
      }
      return say('AI 自己回答');
    };
    const p = store.send('找人討論要不要換伺服器');
    await new Promise((r) => setTimeout(r, 150));
    store.stop();
    await p;
    const tool = store.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ toolCallId: 'call_1' });
    expect(JSON.parse(tool!.content).ok).toBe(false);
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])).toEqual([]);
  });
});

test('找 Agent 卡「換一批」：讀螢幕唸換了誰', async () => {
  const { AccessibilityInfo } = require('react-native');
  const { net, store } = await setup();
  const STAT = { zh: '統計學家', en: 'Statistician', keywords: ['統計'] };
  script(net, { roles: [[HISTORIAN], [STAT]], picks: [[{ name: hist.n[0], why: '看過去' }], [{ name: '統計學家', why: '看數字' }]] });
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '找人討論要不要換伺服器');
  await fireEvent.press(screen.getByLabelText('送出'));
  await screen.findByText('找了這幾位一起討論');
  await fireEvent.press(screen.getByText('換一批'));
  await waitFor(() => expect(announce).toHaveBeenCalledWith('換了 1 位：統計學家'));
  announce.mockRestore();
});
