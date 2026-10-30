import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo, type Agent } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 一般聊天也能 @ 拉人；討論串有自己的成員

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

const done = { message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 50 };
const say = (content: string) => ({ lines: [{ message: { role: 'assistant', content }, done: false }, done] });
const whoBids = (body: any) => /^你是「(.+?)」：/.exec(body.messages[0].content)?.[1] ?? '';
const whoSpeaks = (body: any) => /^你是「(.+?)」，正在/.exec(body.messages[0].content)?.[1] ?? '';

/**
 * 劇本：一般聊天第一次回答叫 invite_agents，之後照常回答「AI 自己回答」；
 * 找人時依序用 picks 裡的每一批；舉手 bids；Agent 講話回「名字說了」
 */
function script(net: FakeOllamaNet, opts: { picks?: object[][]; bids?: Record<string, number[]>; invite?: boolean } = {}) {
  const batches = [...(opts.picks ?? [])];
  let called = false;
  net.hosts.get(A)!.reply = (body: any) => {
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
    await fireEvent.press(await screen.findByLabelText('討論串，點一下可以刪除'));
    expect(seen[0]).toEqual(['成員與討論設定', '刪除這個討論串', '取消']);
    // 成員面板蓋在卡片上（卡片是讀螢幕範圍，測試預設略過它旁邊的東西）
    expect(await screen.findByText('幫我挑', { includeHiddenElements: true })).toBeTruthy();
  });
});
