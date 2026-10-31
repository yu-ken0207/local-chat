import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo, ActionSheetIOS, Alert, ScrollView } from 'react-native';

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
      return { lines: [{ message: { content: JSON.stringify({ roles: [{ zh: '歷史學家', en: 'Historian', keywords: ['歷史'] }, { zh: '統計學家', en: 'Statistician', keywords: ['統計'] }] }) }, done: false }, done] };
    }
    if (body.format?.properties?.picks) {
      const hist = getEntry('agency:academic/academic-historian')!.n[0];
      return { lines: [{ message: { content: JSON.stringify({ picks: [{ name: hist, why: '看過去的脈絡' }, { name: '統計學家', why: '看數字' }] }) }, done: false }, done] };
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
  expect(await screen.findByText('2 位成員')).toBeTruthy();
  expect(screen.getByText('2 位 Agent 已經準備好，說說要討論什麼。')).toBeTruthy();
});

test('討論：你在右、Agent 在左帶名字；討論中可以插話、可以暫停；說完了可以繼續討論', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  // 連續上限 1、工程師第二輪不到門檻：插話沒被處理的話就沒人回
  await store.setGroupSettings({ maxStreak: 1 });
  let release!: () => void;
  script(net, { 財務長: [8, 0, 0], 工程師: [0, 3, 0] }, { hold: new Promise<void>((r) => (release = r)) });
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
  expect(await screen.findByText('繼續討論')).toBeTruthy();
  // 畫面不寫「大家說完了」，只留按鈕
  expect(screen.queryByText('大家說完了')).toBeNull();
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
  expect(await screen.findByText('可以收尾了')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('先不要'));
  expect(screen.queryByText('可以收尾了')).toBeNull();
});

test('成員面板：改發言方式、拿掉成員；幫我挑照話題從圖鑑挑', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  script(net, {});
  await screenOf(store);
  await fireEvent.press(await screen.findByText('2 位成員'));
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
  expect(net.chatBodies().some((b) => b.format?.properties?.picks)).toBe(true);
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
  expect(screen.getByText('1. 估修理費')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('投方案 1'));
  expect(await screen.findByLabelText('你投了方案 1')).toBeTruthy();
  expect(screen.getByLabelText('方案 1：今年換，1 票')).toBeTruthy();
  expect(screen.getByLabelText('釘選的結論：先修再說，點一下看完整內容')).toBeTruthy();
  await fireEvent.press(screen.getAllByLabelText('取消釘選')[0]);
  await waitFor(() => expect(screen.queryByLabelText('釘選的結論：先修再說，點一下看完整內容')).toBeNull());
  // 已經收尾了：下面不再顯示「繼續討論」「收尾」
  expect(screen.queryByText('繼續討論')).toBeNull();
});

test('多人對話開討論串：剛開還沒問不顯示「繼續討論」；之前 @ 選人塞進輸入框的字不會跑回來', async () => {
  const { net, store, agents } = await setup();
  for (const a of Object.values(agents)) await store.addMember(a.id);
  script(net, { 財務長: [8, 0], 工程師: [0, 0] });
  await store.send('要換伺服器嗎');
  await screenOf(store);
  expect(await screen.findByText('繼續討論')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '@財');
  await fireEvent.press(await screen.findByLabelText('提到 財務長'));
  expect(await screen.findByDisplayValue('@財務長 ')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '');
  await act(async () => {
    await store.openThread(store.getState().messages[0].id);
  });
  expect(await screen.findByText('以下是討論串')).toBeTruthy();
  expect(screen.queryByText('繼續討論')).toBeNull();
  expect(screen.queryByDisplayValue('@財務長 ')).toBeNull();
});

describe('審查修正：畫面與讀螢幕', () => {
  /** 收尾用的回答 */
  const concludeReply = (body: any) => {
    const reply = (content: string) => ({ lines: [{ message: { content }, done: false }, done] });
    if (body.format?.properties?.options) return reply(JSON.stringify({ question: '要不要換？', options: ['今年換', '先修再說'] }));
    if (body.format?.properties?.choice) return reply(JSON.stringify({ choice: 2, reason: '省錢' }));
    if (body.format?.properties?.consensus) return reply(JSON.stringify({ consensus: '先修再說', disagreements: [], todos: [] }));
    return reply('筆記');
  };

  test('VoiceOver：你說的話、Agent 的名字上有「更多動作」，打開長按選單', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await screenOf(store);
    const seen: string[][] = [];
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => {
      seen.push(o.options);
      cb(o.options.length - 1);
    });
    await fireEvent(screen.getByLabelText('財務長 說'), 'accessibilityAction', { nativeEvent: { actionName: 'more' } });
    await fireEvent(screen.getByLabelText('你說：預算夠嗎'), 'accessibilityAction', { nativeEvent: { actionName: 'more' } });
    expect(seen[0]).toContain('請他展開講');
    expect(seen[1]).toContain('編輯並重送');
  });

  test('重新產生後的 ‹ ›：各自是按鈕，第一個時「上一個」停用', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await store.regenerate(store.getState().messages.at(-1)!.id);
    await screenOf(store);
    expect(screen.getByLabelText('第 2 個回答，共 2 個')).toBeTruthy();
    expect(screen.getByLabelText('下一個回答').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByLabelText('上一個回答'));
    expect(await screen.findByLabelText('第 1 個回答，共 2 個')).toBeTruthy();
  });

  test('成員全部拿掉：結論卡照樣畫成卡片，不會印出原文', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('要換伺服器嗎');
    net.hosts.get(A)!.reply = concludeReply;
    await store.conclude();
    for (const a of Object.values(agents)) await store.removeMember(a.id);
    await screenOf(store);
    expect(screen.getByText('要不要換？')).toBeTruthy();
    expect(screen.queryByText(/"question"/)).toBeNull();
  });

  test('討論停下、建議收尾時，讀螢幕唸一聲', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    await store.setGroupSettings({ maxStreak: 1 });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    script(net, { 財務長: [8, 8], 工程師: [0, 0] }, { conclude: true });
    await screenOf(store);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '開始');
    await fireEvent.press(screen.getByLabelText('送出'));
    await screen.findByText('可以收尾了');
    expect(announce).toHaveBeenCalledWith('可以收尾了');
  });

  test('打字時（沒有 @）不會整個畫面重畫；打了 @ 才更新名單', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    const GroupChat = require('../src/components/GroupChat');
    const spy = jest.spyOn(GroupChat, 'replyTargets');
    await screenOf(store);
    // 等畫面一開始的非同步載入（我的 Agent 等）跑完再算
    await act(async () => await new Promise((r) => setTimeout(r, 100)));
    const before = spy.mock.calls.length;
    for (const text of ['那', '那就', '那就這樣']) await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), text);
    expect(spy.mock.calls.length).toBe(before);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '那就這樣 @財');
    expect(await screen.findByTestId('mention-picker')).toBeTruthy();
  });

  test('打了 @ 還沒送就開討論串：卡片裡的輸入框是空的，@ 名單也收起來', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await screenOf(store);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '@財');
    expect(await screen.findByTestId('mention-picker')).toBeTruthy();
    await act(async () => {
      await store.openThread(store.getState().messages[0].id);
    });
    expect(await screen.findByText('以下是討論串')).toBeTruthy();
    expect(screen.queryByTestId('mention-picker')).toBeNull();
  });

  test('英文介面：結論卡、成員數用半形標點和單複數', async () => {
    const { net, store, agents } = await setup(['財務長']);
    await store.setPref('language', 'en');
    await store.addMember(agents['財務長'].id);
    script(net, { 財務長: [8, 0] });
    await store.send('replace the server?');
    net.hosts.get(A)!.reply = concludeReply;
    await store.conclude();
    await screenOf(store);
    expect(screen.getByText('1 member')).toBeTruthy();
    expect(screen.getByLabelText('Option 2: 先修再說, 1 vote')).toBeTruthy();
    expect(screen.getByText('Conclusion: 先修再說')).toBeTruthy();
    await store.setPref('language', 'zh-Hant');
  });
});

describe('點頭像看 Agent 的資料', () => {
  async function opened() {
    const { net, repo, store, agents } = await setup();
    await repo.updateAgent(agents['財務長'].id, { card: { expertise: '預算控管', stance: '保守', style: '直接', blindSpot: '' }, talk: 0.8 });
    for (const a of Object.values(agents)) await store.addMember(a.id);
    await repo.addNote(agents['財務長'].id, null, '上次主張先修再換');
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await screenOf(store);
    await fireEvent.press(screen.getByLabelText('看 財務長 的資料'), { nativeEvent: { pageX: 30, pageY: 400 } });
    expect(await screen.findByTestId('agent-profile')).toBeTruthy();
    return { net, repo, store, agents };
  }

  test('資料卡：名字、介紹、這段說了幾次與積極度、專長立場風格、最近的筆記', async () => {
    await opened();
    const card = screen.getByTestId('agent-profile');
    expect(within(card).getByText('財務長')).toBeTruthy();
    expect(within(card).getByText('財務長的介紹')).toBeTruthy();
    expect(within(card).getByText('這段說了 1 次，積極度：愛講')).toBeTruthy();
    expect(within(card).getByLabelText('專長：預算控管')).toBeTruthy();
    expect(within(card).getByLabelText('立場：保守')).toBeTruthy();
    expect(within(card).getByLabelText('風格：直接')).toBeTruthy();
    expect(await within(card).findByText('上次主張先修再換')).toBeTruthy();
    // 點外面縮回去
    await fireEvent.press(screen.getByTestId('profile-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('agent-profile')).toBeNull());
  });

  test('@他：把「@財務長 」填進輸入框', async () => {
    await opened();
    await fireEvent.press(screen.getByText('@他'));
    expect(await screen.findByDisplayValue('@財務長 ')).toBeTruthy();
  });

  test('移除：離開這段討論，可以復原', async () => {
    const { store } = await opened();
    await fireEvent.press(screen.getByText('移除'));
    await waitFor(() => expect(store.getState().members.map((m) => m.agent.name)).toEqual(['工程師']));
    expect(store.getState().undo?.message).toBe('「財務長」離開了討論');
    await act(async () => {
      await store.undoLast();
    });
    expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長', '工程師']);
  });

  test('編輯：打開 Agent 編輯面板', async () => {
    await opened();
    await fireEvent.press(screen.getByText('編輯'));
    expect(await screen.findByDisplayValue('預算控管', {}, { timeout: 3000 })).toBeTruthy();
  });
});

describe('審查修正（完整 code review）：資料卡、成員面板', () => {
  test('資料卡開著時不能從左邊滑出對話清單', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await screenOf(store);
    // 從左邊緣往右滑一段：側邊欄要不要接手
    const claims = () => {
      const el = screen.getByTestId('side-drawer', { includeHiddenElements: true } as never);
      const ev = (x: number) => ({
        nativeEvent: { pageX: x, pageY: 400, timestamp: 1016, touches: [{}] },
        touchHistory: { numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: 1016, touchBank: [{ touchActive: true, startPageX: 10, startPageY: 400, startTimeStamp: 1000, currentPageX: x, currentPageY: 400, currentTimeStamp: 1016, previousPageX: 10, previousPageY: 400, previousTimeStamp: 1000 }] },
      });
      el.props.onStartShouldSetResponderCapture(ev(10));
      el.props.onMoveShouldSetResponderCapture(ev(60));
      return !!el.props.onMoveShouldSetResponder(ev(60));
    };
    expect(claims()).toBe(true);
    await fireEvent.press(screen.getByLabelText('看 財務長 的資料'), { nativeEvent: { pageX: 30, pageY: 400 } });
    await screen.findByTestId('agent-profile');
    expect(claims()).toBe(false);
  });

  test('已經離開討論的人：資料卡按「@他」先把他拉回來再填 @', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await store.removeMember(agents['財務長'].id);
    await store.dismissUndo();
    await screenOf(store);
    await fireEvent.press(screen.getByLabelText('看 財務長 的資料'), { nativeEvent: { pageX: 30, pageY: 400 } });
    await screen.findByTestId('agent-profile');
    expect(screen.queryByText('移除')).toBeNull();
    await fireEvent.press(screen.getByText('@他'));
    await waitFor(() => expect(store.getState().members.map((m) => m.agent.name)).toContain('財務長'));
    expect(await screen.findByDisplayValue('@財務長 ')).toBeTruthy();
  });

  test('已刪除的 Agent：資料卡只看資料，沒有 @他、編輯、移除', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await store.deleteAgent(agents['財務長'].id);
    await store.dismissUndo();
    await screenOf(store);
    await fireEvent.press(screen.getByLabelText('看 財務長 的資料'), { nativeEvent: { pageX: 30, pageY: 400 } });
    expect(await screen.findByText('這個 Agent 已經刪除，可以在設定的 Agent 頁復原。')).toBeTruthy();
    expect(screen.queryByText('@他')).toBeNull();
    expect(screen.queryByText('編輯')).toBeNull();
  });

  test('成員面板拿掉成員：面板裡就有「復原」', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, {});
    await screenOf(store);
    await fireEvent.press(await screen.findByText('2 位成員'));
    await fireEvent.press(await screen.findByLabelText('拿掉 工程師'));
    expect(await screen.findByText('「工程師」離開了討論', {}, { includeHiddenElements: true } as never)).toBeTruthy();
    await fireEvent.press(screen.getByText('復原', { includeHiddenElements: true } as never));
    await waitFor(() => expect(store.getState().members.map((m) => m.agent.name)).toEqual(['財務長', '工程師']));
  });
});

describe('審查修正（完整 code review）：低', () => {
  test('點頭像拿不到手指位置（讀螢幕、鍵盤）：資料卡照樣從中間出現', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await screenOf(store);
    await fireEvent.press(screen.getByLabelText('看 財務長 的資料'));
    expect(await screen.findByTestId('agent-profile')).toBeTruthy();
  });

  test('「復原」提示還在時按複製：不會等它消失後才冒出「已複製」，改成讀螢幕播報', async () => {
    const { net, store, agents } = await setup();
    for (const a of Object.values(agents)) await store.addMember(a.id);
    script(net, { 財務長: [8, 0], 工程師: [0, 0] });
    await store.send('預算夠嗎');
    await screenOf(store);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await act(async () => {
      await store.deleteMessage(store.getState().messages[0].id);
    });
    expect(store.getState().undo).not.toBeNull();
    await fireEvent.press(screen.getByText('複製'));
    expect(announce).toHaveBeenCalledWith('已複製');
    await act(async () => {
      await store.dismissUndo();
    });
    await act(async () => await new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText('已複製')).toBeNull();
  });
});
