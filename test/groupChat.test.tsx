import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, ScrollView } from 'react-native';

import { getEntry } from '../src/agents/catalog';
import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo, type Agent } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 多 AI 討論的畫面：邀請 Agent、聊天氣泡、討論中可以插話與暫停、@ 選人、成員面板

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

const done = { message: { content: '' }, done: true, eval_count: 5, prompt_eval_count: 50 };
const whoBids = (body: any) => /^你是「(.+?)」：/.exec(body.messages[0].content)?.[1] ?? '';
const whoSpeaks = (body: any) => /^你是「(.+?)」，正在/.exec(body.messages[0].content)?.[1] ?? '';

/** 劇本：bids[名字] 每一輪的分數；講話回「名字說第 n 次」 */
function script(net: FakeOllamaNet, bids: Record<string, number[]>, opts: { hold?: Promise<unknown>; conclude?: boolean; replyTo?: Record<string, string> } = {}) {
  const spoke: Record<string, number> = {};
  net.hosts.get(A)!.reply = (body: any) => {
    if (body.format?.properties?.roles) {
      return { lines: [{ message: { content: JSON.stringify({ roles: [{ zh: '歷史學家', en: 'Historian' }, { zh: '統計學家', en: 'Statistician' }] }) }, done: false }, done] };
    }
    if (body.format) {
      const name = whoBids(body);
      return { lines: [{ message: { content: JSON.stringify({ score: bids[name]?.shift() ?? 0, reply_to: opts.replyTo?.[name] ?? '', conclude: !!opts.conclude }) }, done: false }, done] };
    }
    const name = whoSpeaks(body);
    spoke[name] = (spoke[name] ?? 0) + 1;
    return { lines: [{ message: { content: `${name}說第${spoke[name]}次` }, done: false }, done], holdLast: opts.hold };
  };
}

async function setup(members = ['財務長', '工程師']) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  const repo = new Repo(memoryDb());
  const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  const agents: Record<string, Agent> = {};
  for (const name of members) agents[name] = await repo.createAgent({ name, intro: `${name}的介紹`, emoji: '🙂', mine: true });
  return { net, repo, store, agents };
}

const screenOf = (store: ChatStore) => render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);

afterEach(() => jest.restoreAllMocks());

test('空白對話可以邀請 Agent：從我的 Agent 加進來，上面出現成員列', async () => {
  const { store } = await setup();
  await screenOf(store);
  await fireEvent.press(screen.getByText('邀請幾個 Agent 一起討論'));
  await fireEvent.press(await screen.findByText('從我的 Agent 加'));
  await fireEvent.press(await screen.findByLabelText('加入 財務長'));
  await fireEvent.press(await screen.findByLabelText('加入 工程師'));
  await waitFor(() => expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長', '工程師']));
  await fireEvent.press(screen.getByText('完成'));
  expect(await screen.findByText('2 位成員 · 自由搶話')).toBeTruthy();
  expect(screen.getByText('2 位 Agent 已經準備好，說說要討論什麼。')).toBeTruthy();
});

test('討論：你在右、Agent 在左帶名字；討論中可以插話、可以暫停；說完了可以繼續討論', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  let release!: () => void;
  script(net, { 財務長: [8, 0, 0], 工程師: [0, 6, 0] }, { hold: new Promise<void>((r) => (release = r)) });
  await screenOf(store);
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '要換伺服器嗎');
  await fireEvent.press(screen.getByLabelText('送出'));
  expect(await screen.findByText('財務長 正在說話…')).toBeTruthy();
  // 討論中照樣可以送出
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '預算只有 10 萬');
  expect(screen.getByLabelText('送出').props.accessibilityState).not.toMatchObject({ disabled: true });
  await fireEvent.press(screen.getByLabelText('送出'));
  expect(await screen.findByLabelText('你說：預算只有 10 萬')).toBeTruthy();
  await act(async () => release());
  expect(await screen.findByText('工程師說第1次')).toBeTruthy();
  expect(screen.getByLabelText('你說：要換伺服器嗎')).toBeTruthy();
  expect(screen.getAllByText('財務長').length).toBeGreaterThan(0);
  await waitFor(() => expect(store.getState().running).toEqual({}));
  expect(await screen.findByText('大家說完了')).toBeTruthy();
  script(net, { 財務長: [6, 0], 工程師: [0, 0] });
  await fireEvent.press(screen.getByText('繼續討論'));
  await waitFor(() => expect(screen.getAllByText('財務長說第1次')).toHaveLength(2));
});

test('暫停：講到一半停下來', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  net.hosts.get(A)!.reply = (body: any) =>
    body.format ? { lines: [{ message: { content: '{"score":9,"reply_to":"","conclude":false}' }, done: false }, done] } : { lines: [{ message: { content: '講到一半' }, done: false }], hang: true };
  await screenOf(store);
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '開始');
  await fireEvent.press(screen.getByLabelText('送出'));
  await fireEvent.press(await screen.findByText('暫停'));
  expect(await screen.findByText('已停止')).toBeTruthy();
  await waitFor(() => expect(store.getState().running).toEqual({}));
});

test('回的不是上一則才顯示「回覆 某某」，點了跳過去', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  script(net, { 財務長: [8, 0, 0], 工程師: [0, 7, 0] }, { replyTo: { 工程師: '使用者' } });
  await screenOf(store);
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '要換嗎');
  await fireEvent.press(screen.getByLabelText('送出'));
  expect(await screen.findByText('工程師說第1次')).toBeTruthy();
  // 財務長回的是你（就是上一則）：不顯示；工程師回的也是你（中間隔了財務長）：顯示
  const quotes = screen.getAllByLabelText(/^回覆 /);
  expect(quotes).toHaveLength(1);
  expect(quotes[0].props.accessibilityLabel).toBe('回覆 你，點一下看那則');
  const to = jest.spyOn(ScrollView.prototype as any, 'scrollTo').mockImplementation(() => {});
  await fireEvent(screen.getByText('要換嗎').parent!.parent!.parent!, 'layout', { nativeEvent: { layout: { y: 500, x: 0, width: 300, height: 40 } } });
  await fireEvent.press(quotes[0]);
  expect(to).toHaveBeenCalledWith({ y: 420, animated: true });
});

test('打 @ 跳出名單（成員在前，我的 Agent 在後），點了填進輸入框', async () => {
  const { repo, store, agents } = await setup();
  await store.addMember(agents['財務長'].id);
  await repo.createAgent({ name: '財務分析師', intro: '算數字', mine: true });
  await screenOf(store);
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '請 @財');
  const picker = await screen.findByTestId('mention-picker');
  expect(within(picker).getAllByRole('button').map((b) => b.props.accessibilityLabel)).toEqual(['提到 財務長', '提到 財務分析師']);
  await fireEvent.press(within(picker).getByLabelText('提到 財務分析師'));
  expect(await screen.findByDisplayValue('請 @財務分析師 ')).toBeTruthy();
});

test('長按 Agent 說的話：可以請他展開講', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  script(net, { 財務長: [8, 0], 工程師: [0, 0] });
  await store.send('預算夠嗎');
  await screenOf(store);
  const seen: string[][] = [];
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => {
    seen.push(o.options);
    cb(o.options.indexOf('請他展開講'));
  });
  const msg = store.getState().messages.at(-1)!;
  await fireEvent(screen.getByTestId(`message-${msg.id}`), 'longPress');
  expect(seen[0]).toEqual(['複製', '分享', '請他展開講', '重新產生', '詳細資訊', '刪除', '取消']);
  await waitFor(() => expect(store.getState().messages.at(-1)).toMatchObject({ agentId: agents['財務長'].id, replyTo: msg.id }));
});

test('大家覺得可以收尾：出現提示，可以繼續聊或先不要', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  await store.setGroupSettings({ maxStreak: 1 });
  script(net, { 財務長: [8, 8], 工程師: [0, 0] }, { conclude: true });
  await screenOf(store);
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '開始');
  await fireEvent.press(screen.getByLabelText('送出'));
  expect(await screen.findByText('大家覺得差不多可以收尾了')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('先不要'));
  expect(screen.queryByText('大家覺得差不多可以收尾了')).toBeNull();
});

test('成員面板：改發言方式、拿掉成員；幫我挑照話題從圖鑑挑', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  script(net, {});
  await screenOf(store);
  await fireEvent.press(await screen.findByText('2 位成員 · 自由搶話'));
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => cb(o.options.indexOf('輪流')));
  await fireEvent.press(await screen.findByLabelText('發言方式，自由搶話'));
  expect(await screen.findByLabelText('發言方式，輪流')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('拿掉 工程師'));
  await waitFor(() => expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長']));
  jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('要不要改用新的統計方法'));
  await fireEvent.press(screen.getByText('幫我挑'));
  const hist = getEntry('agency:academic/academic-historian')!.n[0];
  expect(await screen.findByLabelText(`加入 ${hist}`)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText(`加入 ${hist}`));
  await waitFor(() => expect(store.getState().members.map((m) => m.agent.name)).toContain(hist));
  expect(net.chatBodies().some((b) => b.format?.properties?.roles)).toBe(true);
});

test('收尾：按「收尾」出結論卡（票數、共識、待辦），可以投你的一票；釘在最上面可以取消', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  script(net, { 財務長: [8, 0], 工程師: [0, 0] });
  await store.send('要換伺服器嗎');
  net.hosts.get(A)!.reply = (body: any) => {
    const reply = (content: string) => ({ lines: [{ message: { content }, done: false }, done] });
    if (body.format?.properties?.options) return reply(JSON.stringify({ question: '要不要換？', options: ['今年換', '先修再說'] }));
    if (body.format?.properties?.choice) return reply(JSON.stringify({ choice: 2, reason: '省錢' }));
    if (body.format?.properties?.consensus) return reply(JSON.stringify({ consensus: '先修再說', disagreements: [], todos: ['估修理費'] }));
    return reply('筆記');
  };
  await screenOf(store);
  await fireEvent.press(await screen.findByText('收尾'));
  expect(await screen.findByText('要不要換？')).toBeTruthy();
  expect(screen.getByLabelText('方案 2：先修再說，2 票')).toBeTruthy();
  expect(screen.getByText('先修再說', { exact: true })).toBeTruthy();
  expect(screen.getByText('• 估修理費')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('投方案 1'));
  expect(await screen.findByLabelText('你投了方案 1')).toBeTruthy();
  expect(screen.getByLabelText('方案 1：今年換，1 票')).toBeTruthy();
  expect(screen.getByLabelText('釘選的結論：先修再說，點一下看完整內容')).toBeTruthy();
  await fireEvent.press(screen.getAllByLabelText('取消釘選')[0]);
  await waitFor(() => expect(screen.queryByLabelText('釘選的結論：先修再說，點一下看完整內容')).toBeNull());
});
