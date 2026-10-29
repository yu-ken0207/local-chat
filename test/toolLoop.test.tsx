import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import type { PhoneTool, ToolInput } from '../src/lib/tools';
import { ChatStore, MAX_TOOL_ROUNDS, type ChatEvent } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet, type FakeHost } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 手機上動手做事：AI 叫工具、只讀的直接做、會改東西的出確認卡、確認後接著回答、可以復原

const A = 'http://192.168.1.20:11434';
const NOW = new Date(2026, 9, 29, 16, 40).getTime();

/** 假的行事曆工具：看行事曆（只讀）、加行程（要確認，結束時間沒說就補開始後 1 小時） */
function fakeCalendar() {
  const created: ToolInput[] = [];
  const removed: unknown[] = [];
  const listEvents: PhoneTool = {
    name: 'list_events',
    description: 'List events',
    inputSchema: { type: 'object', properties: { day: { type: 'string', format: 'date' } } },
    annotations: { readOnlyHint: true },
    label: '看行事曆',
    run: async () => ({ data: [{ title: '晨會' }], summary: '看了行事曆（1 筆）' }),
  };
  const createEvent: PhoneTool = {
    name: 'create_event',
    description: 'Add an event',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' } },
      required: ['title', 'start'],
    },
    annotations: {},
    label: '加行程',
    verb: '加入',
    fields: { title: '標題', start: '開始', end: '結束' },
    describe: (i) => `新增「${i.title}」`,
    fillDefaults: (i) => (i.end ? { input: i, guessed: [] } : { input: { ...i, end: String(i.start).replace(/T(\d\d)/, (_m, h) => `T${String(Number(h) + 1).padStart(2, '0')}`) }, guessed: ['end'] }),
    check: (i, ctx) => (Date.parse(String(i.start)) < ctx.now ? 'The start time is in the past.' : null),
    run: async (i) => {
      created.push(i);
      return { data: { id: `ev${created.length}` }, summary: '新增 1 個行程' };
    },
    undo: async (data) => void removed.push(data),
  };
  return { tools: [listEvents, createEvent], created, removed };
}

const toolCall = (name: string, args: unknown, id = 'call_1') => ({ message: { role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: args } }] }, done: false });
const toolCalls = (...calls: [string, unknown][]) => ({ message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args], i) => ({ id: `call_${i + 1}`, function: { name, arguments: args } })) }, done: false });
const text = (content: string) => ({ message: { role: 'assistant', content }, done: false });
const done = { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 5, prompt_eval_count: 50 };

/** 依序回答：第 n 次聊天請求用第 n 個；用完了就一直用最後一個 */
function script(host: FakeHost, replies: ((body: any) => unknown[])[]) {
  let i = 0;
  host.reply = (body) => ({ lines: replies[Math.min(i++, replies.length - 1)](body) });
}

async function setup(options: { tools?: boolean; repo?: Repo } = {}) {
  const net = new FakeOllamaNet();
  const host = net.addHost(A, { models: [{ name: 'gemma4:12b', tools: options.tools ?? true }, { name: 'llama3:latest' }] });
  const cal = fakeCalendar();
  const events: ChatEvent[] = [];
  const repo = options.repo ?? new Repo(memoryDb());
  const store = new ChatStore({
    repo,
    client: net.client,
    wifiIp: async () => '192.168.1.10',
    throttleMs: 5,
    autoScan: false,
    tools: cal.tools,
    timeZone: () => 'Asia/Taipei',
    now: () => NOW,
    onEvent: (e) => events.push(e),
  });
  await store.init();
  if (!options.repo) {
    await store.addHost('192.168.1.20');
    await store.loadModels(A);
    await store.selectModel(A, 'gemma4:12b');
  } else {
    await store.loadModels(A);
  }
  return { net, host, store, repo, cal, events };
}

const pending = (store: ChatStore) => store.getState().messages.flatMap((m) => m.actions ?? []).filter((a) => a.status === 'pending');
const lastText = (store: ChatStore) => store.getState().messages.filter((m) => m.role === 'assistant' && m.content).at(-1)?.content;

describe('送給模型的內容', () => {
  test('會叫工具的模型：帶工具清單，系統提示詞說現在幾點與時區', async () => {
    const { net, store } = await setup();
    await store.send('你好');
    const body = net.chatBodies()[0];
    expect(body.tools.map((x: any) => x.function.name)).toEqual(['list_events', 'create_event', 'ask_user']);
    expect(body.messages[0].content).toContain('2026-10-29 16:40 (Thursday), time zone Asia/Taipei');
  });

  test('不會叫工具的模型：不送工具清單，照舊聊天', async () => {
    const { net, store } = await setup();
    await store.selectModel(A, 'llama3:latest');
    await store.send('你好');
    const body = net.chatBodies()[0];
    expect(body.tools).toBeUndefined();
    expect(body.messages[0].content).not.toContain('tools');
  });
});

describe('只讀的工具', () => {
  test('直接做，結果交回模型，接著回答；畫面上一行帶過', async () => {
    const { net, host, store, events } = await setup();
    script(host, [() => [toolCall('list_events', { day: '2026-11-04' }), done], () => [text('那天有晨會。'), done]]);
    await store.send('11/4 有什麼行程？');
    await waitFor(() => expect(lastText(store)).toBe('那天有晨會。'));
    const second = net.chatBodies()[1].messages;
    expect(second.at(-2)).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'list_events', arguments: { day: '2026-11-04' } } }] });
    expect(second.at(-1)).toEqual({ role: 'tool', content: '{"ok":true,"result":[{"title":"晨會"}]}', tool_name: 'list_events', tool_call_id: 'call_1' });
    expect(store.getState().messages.find((m) => m.role === 'tool')?.detail).toBe('看了行事曆（1 筆）');
    expect(events).toEqual(['answered']);
  });

  test('輸入不對、不存在的工具：原因交回模型，讓它重來', async () => {
    const { net, host, store } = await setup();
    script(host, [() => [toolCall('list_events', { day: '11/4' }), done], () => [toolCall('send_sms', {}), done], () => [text('好'), done]]);
    await store.send('11/4 有什麼行程？');
    await waitFor(() => expect(lastText(store)).toBe('好'));
    const bodies = net.chatBodies();
    expect(JSON.parse(bodies[1].messages.at(-1).content)).toMatchObject({ ok: false, error: expect.stringContaining('Invalid arguments for list_events') });
    expect(JSON.parse(bodies[2].messages.at(-1).content)).toMatchObject({ ok: false, error: 'There is no tool named "send_sms".' });
  });

  test(`叫太多輪（超過 ${MAX_TOOL_ROUNDS} 輪）就停下來說明`, async () => {
    const { net, host, store } = await setup();
    script(host, [() => [toolCall('list_events', {}), done]]);
    await store.send('一直查');
    await waitFor(() => expect(store.getState().messages.at(-1)?.role).toBe('note'));
    expect(net.chatBodies()).toHaveLength(MAX_TOOL_ROUNDS);
    expect(store.getState().messages.at(-1)?.content).toContain('做到一半停下來了');
  });
});

describe('會改東西的工具', () => {
  async function askToAdd(args: unknown = { title: '帶小孩看牙醫', start: '2026-11-04T15:00' }) {
    const ctx = await setup();
    script(ctx.host, [() => [toolCall('create_event', args), done], (body) => [text(`已經加好了（${JSON.parse(body.messages.at(-1).content).ok ? 'ok' : 'no'}）`), done]]);
    await ctx.store.send('下週三下午三點帶小孩看牙醫');
    await waitFor(() => expect(ctx.store.getState().streaming).toBeNull());
    return ctx;
  }

  test('出確認卡：還沒做、補上的欄位標出來、對話清單顯示等你確認', async () => {
    const { store, cal, net } = await askToAdd();
    const [a] = pending(store);
    expect(a).toMatchObject({ tool: 'create_event', input: { title: '帶小孩看牙醫', start: '2026-11-04T15:00', end: '2026-11-04T16:00' }, guessed: ['end'] });
    expect(cal.created).toEqual([]);
    expect(net.chatBodies()).toHaveLength(1);
    expect((await store.listSessions())[0].pending).toBe(1);
  });

  test('按加入：真的做、結果交回模型、接著回答；可以復原', async () => {
    const { store, cal, net, events } = await askToAdd();
    const [a] = pending(store);
    await store.approveAction(a.id);
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（ok）'));
    expect(cal.created).toEqual([{ title: '帶小孩看牙醫', start: '2026-11-04T15:00', end: '2026-11-04T16:00' }]);
    expect(net.chatBodies()[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'create_event', tool_call_id: 'call_1' });
    const doneAction = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    expect(doneAction).toMatchObject({ status: 'done', summary: '新增 1 個行程', result: { id: 'ev1' } });
    expect(events).toContain('acted');
    expect((await store.listSessions())[0].pending).toBe(0);

    await store.undoAction(a.id);
    expect(cal.removed).toEqual([{ id: 'ev1' }]);
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])[0].status).toBe('undone');
  });

  test('修改後加入：照改過的做，並告訴模型改了什麼', async () => {
    const { store, cal, net } = await askToAdd();
    await store.approveAction(pending(store)[0].id, { start: '2026-11-05T15:00' });
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（ok）'));
    expect(cal.created[0].start).toBe('2026-11-05T15:00');
    expect(JSON.parse(net.chatBodies()[1].messages.at(-1).content).note).toContain('start: "2026-11-04T15:00" -> "2026-11-05T15:00"');
  });

  test('改壞了：不做，跟使用者說格式不對，確認卡還在', async () => {
    const { store, cal } = await askToAdd();
    await expect(store.approveAction(pending(store)[0].id, { start: '明天' })).rejects.toThrow('格式不對');
    expect(cal.created).toEqual([]);
    expect(pending(store)).toHaveLength(1);
  });

  test('按不要並說原因：不做，原因交回模型', async () => {
    const { store, cal, net } = await askToAdd();
    await store.declineAction(pending(store)[0].id, '改成週四');
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（no）'));
    expect(cal.created).toEqual([]);
    expect(JSON.parse(net.chatBodies()[1].messages.at(-1).content)).toEqual({ ok: false, error: 'The user declined this action.', reason: '改成週四', item: '新增「帶小孩看牙醫」' });
  });

  test('App 規則擋掉的（時間在過去）：不出確認卡，原因交回模型', async () => {
    const { store, net } = await askToAdd({ title: 'x', start: '2026-10-01T09:00' });
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（no）'));
    expect(pending(store)).toEqual([]);
    expect(JSON.parse(net.chatBodies()[1].messages.at(-1).content).error).toBe('The start time is in the past.');
  });

  test('沒按確認就說了別的：等著的動作當作不要', async () => {
    const { store, net, cal } = await askToAdd();
    await store.send('算了，今天天氣如何？');
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(pending(store)).toEqual([]);
    expect(cal.created).toEqual([]);
    const msgs = net.chatBodies().at(-1).messages;
    expect(JSON.parse(msgs.at(-2).content)).toMatchObject({ error: expect.stringContaining('did not confirm'), item: expect.stringContaining('帶小孩看牙醫') });
    expect(msgs.at(-1)).toMatchObject({ role: 'user', content: '算了，今天天氣如何？' });
  });

  test('App 關掉再開：確認卡還在，按了照樣接著做', async () => {
    const first = await askToAdd();
    const again = await setup({ repo: first.repo });
    script(again.host, [() => [text('加好了'), done]]);
    expect(pending(again.store)).toHaveLength(1);
    await again.store.approveAction(pending(again.store)[0].id);
    await waitFor(() => expect(lastText(again.store)).toBe('加好了'));
    expect(again.cal.created).toHaveLength(1);
  });
});

describe('畫面', () => {
  jest.setTimeout(20_000);

  async function screenWithCard() {
    const ctx = await setup();
    script(ctx.host, [() => [toolCall('create_event', { title: '帶小孩看牙醫', start: '2026-11-04T15:00' }), done], () => [text('好了'), done]]);
    await render(<ChatScreen store={ctx.store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '下週三下午三點帶小孩看牙醫');
    await fireEvent.press(screen.getByLabelText('送出'));
    await screen.findByText('加行程');
    return ctx;
  }

  test('確認卡在對話裡：一句話、欄位、AI 猜的欄位有標出來；按加入後變成一行，可以復原', async () => {
    const { cal } = await screenWithCard();
    expect(screen.getByText('新增「帶小孩看牙醫」')).toBeTruthy();
    expect(screen.getByLabelText('結束：11/4（週三）16:00（AI 猜的）')).toBeTruthy();
    expect(screen.getByText('開始：11/4（週三）15:00')).toBeTruthy();
    await fireEvent.press(screen.getByText('加入'));
    expect(await screen.findByText('✓ 新增 1 個行程')).toBeTruthy();
    expect(await screen.findByText('好了')).toBeTruthy();
    expect(cal.created).toHaveLength(1);
    await fireEvent.press(screen.getByText('復原'));
    expect(await screen.findByText('已復原：新增 1 個行程')).toBeTruthy();
  });

  test('修改時間用時間選擇器：選了就照選的做；選填的結束時間可以拿掉再加上', async () => {
    const { cal } = await screenWithCard();
    await fireEvent.press(screen.getByText('修改'));
    expect(screen.getByLabelText('開始').props.accessibilityHint).toBe('datetime');
    await fireEvent(screen.getByLabelText('開始'), 'valueChange', new Date(2026, 10, 5, 16, 0));
    // 開始是必填，不能拿掉；結束可以
    expect(screen.getAllByText('拿掉')).toHaveLength(1);
    await fireEvent.press(screen.getByText('拿掉'));
    expect(screen.queryByLabelText('結束')).toBeNull();
    await fireEvent.press(screen.getByText('加上'));
    await fireEvent(screen.getByLabelText('結束'), 'valueChange', new Date(2026, 10, 5, 18, 30));
    await fireEvent.press(screen.getByText('加入'));
    await waitFor(() => expect(cal.created).toHaveLength(1));
    expect(cal.created[0]).toMatchObject({ start: '2026-11-05T16:00', end: '2026-11-05T18:30' });
  });

  test('沒按確認卡就直接打字：那一行寫「跳過」，跟按「不要」分開', async () => {
    const { cal } = await screenWithCard();
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '改成兩小時');
    await fireEvent.press(screen.getByLabelText('送出'));
    expect(await screen.findByText('跳過：加行程「帶小孩看牙醫」（你直接打字了）')).toBeTruthy();
    expect(cal.created).toEqual([]);
  });

  test('按修改可以改欄位再加入', async () => {
    const { cal } = await screenWithCard();
    await fireEvent.press(screen.getByText('修改'));
    await fireEvent.changeText(screen.getByLabelText('標題'), '看牙醫');
    await fireEvent.press(screen.getByText('加入'));
    await screen.findByText('✓ 新增 1 個行程');
    expect(cal.created[0].title).toBe('看牙醫');
  });

  test('按不要可以說要改成怎樣', async () => {
    const { cal, net } = await screenWithCard();
    await fireEvent.press(screen.getByText('不要'));
    await fireEvent.changeText(screen.getByLabelText('要改成怎樣？（可以不填）'), '改成週四');
    await fireEvent.press(screen.getByText('送出'));
    expect(await screen.findByText('沒有做：加行程「帶小孩看牙醫」')).toBeTruthy();
    expect(cal.created).toEqual([]);
    await waitFor(() => expect(JSON.parse(net.chatBodies()[1].messages.at(-1).content).reason).toBe('改成週四'));
  });
});

describe('問使用者選擇題', () => {
  async function asked(options: unknown = ['早上 9:00', '晚上 8:00']) {
    const ctx = await setup();
    script(ctx.host, [() => [toolCall('ask_user', { question: '明天幾點提醒你？', options }), done], (body) => [text(`收到：${body.messages.at(-1).content}`), done]]);
    await ctx.store.send('明天提醒我繳電費');
    await waitFor(() => expect(ctx.store.getState().streaming).toBeNull());
    return ctx;
  }

  test('出選擇題卡，選了之後答案交回模型', async () => {
    const { store } = await asked();
    const [q] = pending(store);
    expect(q).toMatchObject({ tool: 'ask_user', input: { question: '明天幾點提醒你？', options: ['早上 9:00', '晚上 8:00'] } });
    await store.approveAction(q.id, { answer: '晚上 8:00' });
    await waitFor(() => expect(lastText(store)).toBe('收到：{"ok":true,"result":{"answer":"晚上 8:00"}}'));
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])[0]).toMatchObject({ status: 'done', summary: '你回答：晚上 8:00' });
  });

  test('選項少於 2 個：退回模型重問', async () => {
    const { net, store } = await asked(['只有一個']);
    await waitFor(() => expect(net.chatBodies()).toHaveLength(2));
    expect(pending(store)).toEqual([]);
    expect(JSON.parse(net.chatBodies()[1].messages.at(-1).content).error).toContain('needs at least 2 items');
  });

  test('畫面：點選項、自己打字、不回答', async () => {
    const { store } = await asked();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    expect(screen.getByText('明天幾點提醒你？')).toBeTruthy();
    await fireEvent.press(screen.getByText('其他…'));
    await fireEvent.changeText(screen.getByLabelText('你的回答'), '中午');
    await fireEvent.press(screen.getByText('送出'));
    expect(await screen.findByText('你回答：中午')).toBeTruthy();
  });

  test('畫面：按不回答', async () => {
    const { store } = await asked();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.press(screen.getByText('不回答'));
    expect(await screen.findByText('沒有回答')).toBeTruthy();
  });
});

describe('清單卡（一次好幾件）', () => {
  async function three() {
    const ctx = await setup();
    script(ctx.host, [
      () => [toolCalls(['create_event', { title: '校慶運動會', start: '2026-11-07T09:00' }], ['create_event', { title: '親師座談會', start: '2026-11-13T18:30' }], ['create_event', { title: '戶外教學', start: '2026-11-20T08:00' }]), done],
      () => [text('都處理好了'), done],
    ]);
    await ctx.store.send('通知單上的活動幫我加到行事曆');
    await waitFor(() => expect(ctx.store.getState().streaming).toBeNull());
    return ctx;
  }

  test('取消勾選的不做、改過的照改過的做，全部做完才接著問模型一次', async () => {
    const { store, cal, net } = await three();
    const [a, b, c] = pending(store);
    await store.approveActions([{ id: a.id }, { id: c.id, edited: { title: '戶外教學（帶便當）' } }], [b.id]);
    await waitFor(() => expect(lastText(store)).toBe('都處理好了'));
    expect(cal.created.map((x) => x.title)).toEqual(['校慶運動會', '戶外教學（帶便當）']);
    expect(net.chatBodies()).toHaveLength(2);
    // 取消勾選的先記下來，但交給模型時照叫的順序排，而且寫明是哪一件（不然 AI 會說三件都做了）
    const results = net.chatBodies()[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));
    expect(results.map((r: any) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toMatchObject({ error: expect.stringContaining('unchecked'), item: expect.stringContaining('親師座談會') });
  });

  test('改壞了：一件都不做', async () => {
    const { store, cal } = await three();
    const [a, b] = pending(store);
    await expect(store.approveActions([{ id: a.id }, { id: b.id, edited: { start: '下週五' } }])).rejects.toThrow('格式不對');
    expect(cal.created).toEqual([]);
    expect(pending(store)).toHaveLength(3);
  });

  test('畫面：合成一張卡，取消勾選一件、修改一件，按「加入 2 個」', async () => {
    const { store, cal } = await three();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    expect(screen.getByText('加行程（3 件）')).toBeTruthy();
    await fireEvent.press(screen.getByRole('checkbox', { name: /親師座談會/ }));
    await fireEvent.press(screen.getAllByText('修改')[0]);
    await fireEvent.changeText(screen.getByLabelText('標題'), '校慶');
    await fireEvent.press(screen.getByText('好'));
    await fireEvent.press(screen.getByText('加入 2 個'));
    await waitFor(() => expect(cal.created.map((x) => x.title)).toEqual(['校慶', '戶外教學']));
    expect(await screen.findByText('都處理好了')).toBeTruthy();
    expect(screen.getByText('沒有做：加行程「親師座談會」')).toBeTruthy();
  });

  test('畫面：全部不要', async () => {
    const { store, cal, net } = await three();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.press(screen.getByText('全部不要'));
    await fireEvent.press(screen.getByText('送出'));
    expect(await screen.findByText('都處理好了')).toBeTruthy();
    expect(cal.created).toEqual([]);
    expect(net.chatBodies()).toHaveLength(2);
    expect(screen.getAllByText(/^沒有做：加行程「/)).toHaveLength(3);
  });
});
