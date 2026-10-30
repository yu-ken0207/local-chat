import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Keyboard, ScrollView, TextInput } from 'react-native';

import { ChatScreen, coveredBy } from '../src/components/ChatScreen';
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

describe('回答中換對話、按停止', () => {
  /** 讓「看行事曆」停在執行中，等測試放行 */
  function holdListEvents(cal: ReturnType<typeof fakeCalendar>) {
    const gate = { started: false, release: () => {} };
    cal.tools[0].run = () =>
      new Promise((resolve) => {
        gate.started = true;
        gate.release = () => resolve({ data: [], summary: '看了行事曆（0 筆）' });
      });
    return gate;
  }

  test('工具還在跑時換到別段對話：不接著回答，也不會把回答存進那段；那段留「已停止」可以重新回答', async () => {
    const { net, host, store, cal, repo } = await setup();
    script(host, [() => [text('第一段好了'), done]]);
    await store.send('第一段');
    const first = store.getState().session!.id;
    await store.newSession();
    const second = store.getState().session!.id;
    const gate = holdListEvents(cal);
    script(host, [() => [toolCall('list_events', { day: '2026-11-04' }), done], () => [text('不該出現'), done]]);
    const p = store.send('下週三有什麼');
    await waitFor(() => expect(gate.started).toBe(true));
    await store.openSession(first);
    gate.release();
    await p;
    expect(net.chatBodies()).toHaveLength(2);
    expect(store.getState().session?.id).toBe(first);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['第一段', '第一段好了']);
    expect((await repo.listMessages(second)).map((m) => [m.role, m.role === 'note' ? m.content : ''])).toEqual([
      ['user', ''],
      ['assistant', ''],
      ['tool', ''],
      ['note', '已停止'],
    ]);
    // 回去那段按「重新回答」：接著問模型
    script(host, [() => [text('下週三有晨會'), done]]);
    await store.openSession(second);
    await store.retry();
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'assistant', content: '下週三有晨會' });
  });

  test('工具還在跑時按停止：不再接著問模型，寫一行「已停止」', async () => {
    const { net, host, store, cal, events } = await setup();
    const gate = holdListEvents(cal);
    script(host, [() => [toolCall('list_events', { day: '2026-11-04' }), done], () => [text('不該出現'), done]]);
    const p = store.send('下週三有什麼');
    await waitFor(() => expect(gate.started).toBe(true));
    store.stop();
    gate.release();
    await p;
    expect(net.chatBodies()).toHaveLength(1);
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'note', content: '已停止' });
    expect(events).toContain('stopped');
  });
});

describe('會改東西的工具', () => {
  async function askToAdd(args: unknown = { title: '帶小孩看牙醫', start: '2026-11-04T15:00' }) {
    const ctx = await setup();
    script(ctx.host, [() => [toolCall('create_event', args), done], (body) => [text(`已經加好了（${JSON.parse(body.messages.filter((m: any) => m.role === 'tool').at(-1).content).ok ? 'ok' : 'no'}）`), done]]);
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

  test('第一輪出了卡片：標題只用使用者的第一句話（不拿按完卡片後 AI 說的話）', async () => {
    const { store, net } = await askToAdd();
    await store.declineAction(pending(store)[0].id);
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（no）'));
    await store.titleTask;
    expect(net.titleBodies()).toHaveLength(1);
    expect(net.titleBodies()[0].messages[1].content).toBe('使用者：下週三下午三點帶小孩看牙醫');
  });

  test('按復原：最下面記一行；之後每次回答都在最後提醒模型那件已經不在了', async () => {
    const { store, net } = await askToAdd();
    await store.approveAction(pending(store)[0].id);
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（ok）'));
    const done = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    await store.undoAction(done.id);
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'note', content: '你按了復原：新增 1 個行程' });
    await store.send('那個行程我要準備什麼');
    await waitFor(() => expect(net.chatBodies()).toHaveLength(3));
    const sent = net.chatBodies()[2].messages;
    expect(sent.at(-1)).toEqual({ role: 'system', content: expect.stringContaining('pressed Undo on 「新增「帶小孩看牙醫」」') });
    expect(JSON.parse(sent.find((m: any) => m.role === 'tool').content).undone).toContain('Undo');
  });

  test('修改後加入：照改過的做，並告訴模型改了什麼', async () => {
    const { store, cal, net } = await askToAdd();
    await store.approveAction(pending(store)[0].id, { start: '2026-11-05T15:00' });
    await waitFor(() => expect(lastText(store)).toBe('已經加好了（ok）'));
    expect(cal.created[0].start).toBe('2026-11-05T15:00');
    const sent = net.chatBodies()[1].messages;
    expect(JSON.parse(sent.at(-2).content).note).toContain('start: "2026-11-04T15:00" -> "2026-11-05T15:00"');
    // 只寫在工具結果裡，模型常照自己原本提的日期講：最後再提醒一次，用改過的
    expect(sent.at(-1)).toEqual({ role: 'system', content: expect.stringContaining('what was actually done is 「新增「帶小孩看牙醫」」') });
    expect(sent.at(-1).content).toContain('start: "2026-11-04T15:00" -> "2026-11-05T15:00"');
    expect(sent.at(-1).content).toContain('Your reply must use these changed values');
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
    const sent = net.chatBodies()[1].messages;
    expect(JSON.parse(sent.at(-2).content)).toEqual({ ok: false, error: 'The user declined this action.', reason: '改成週四', item: '新增「帶小孩看牙醫」' });
    // 只寫在工具結果裡，模型常照剛剛的要求說「已經改好了」：最後再提醒一次
    expect(sent.at(-1)).toEqual({ role: 'system', content: expect.stringContaining('The user declined 「新增「帶小孩看牙醫」」') });
    expect(sent.at(-1).content).toContain('Your reply must say it was not done.');
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
    // 不只靠顏色：畫面上也寫「（AI 猜的）」
    expect(screen.getByText('（AI 猜的）')).toBeTruthy();
    expect(screen.getByText('開始：11/4（週三）15:00')).toBeTruthy();
    await fireEvent.press(screen.getByText('加入'));
    expect(await screen.findByText('新增 1 個行程')).toBeTruthy();
    // 前面一格狀態符號（讀螢幕不唸），讀螢幕唸「已完成：…」
    expect(screen.getByText('✓', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    expect(screen.getByLabelText('已完成：新增 1 個行程')).toBeTruthy();
    expect(await screen.findByText('好了')).toBeTruthy();
    expect(cal.created).toHaveLength(1);
    await fireEvent.press(screen.getByText('復原'));
    expect(await screen.findByText('已復原：新增 1 個行程')).toBeTruthy();
    expect(screen.getByText('–', { includeHiddenElements: true })).toBeTruthy();
  });

  test('按修改後點欄位打字：被鍵盤和輸入列擋住就往上捲到看得到；沒擋住不動', async () => {
    await screenWithCard();
    await fireEvent.press(screen.getByText('修改'));
    const measure = (TextInput.prototype as any).measureInWindow as jest.Mock;
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    jest.spyOn(Keyboard, 'metrics').mockReturnValue({ screenX: 0, screenY: 500, width: 390, height: 344 });
    const to = jest.spyOn(ScrollView.prototype as any, 'scrollTo').mockImplementation(() => {});
    const frame = () => act(async () => await new Promise((r) => requestAnimationFrame(r)));
    try {
      // 欄位底在螢幕 600，鍵盤上緣 500：擋住 100，再多留 12
      measure.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(16, 560, 300, 40));
      await fireEvent(screen.getByLabelText('標題'), 'focus');
      await frame();
      expect(to).toHaveBeenCalledWith({ y: 112, animated: true });
      // 在鍵盤上面：不捲
      to.mockClear();
      measure.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) => cb(16, 200, 300, 40));
      await fireEvent(screen.getByLabelText('標題'), 'focus');
      await frame();
      expect(to).not.toHaveBeenCalled();
    } finally {
      measure.mockReset();
    }
  });

  test('擋住多少：欄位底加一點空，超過輸入列上緣（鍵盤上緣減掉輸入列露出的高度）的部分', () => {
    expect(coveredBy(600, 500, 0)).toBe(112);
    expect(coveredBy(600, 500, 60)).toBe(172);
    expect(coveredBy(400, 500, 60)).toBe(0);
  });

  test('凌晨 00:00 照寫 00:00，不會被當成整天', async () => {
    const ctx = await setup();
    script(ctx.host, [() => [toolCall('create_event', { title: '搶票', start: '2026-11-05T00:00' }), done], () => [text('好了'), done]]);
    await render(<ChatScreen store={ctx.store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '11/5 凌晨 12 點搶票');
    await fireEvent.press(screen.getByLabelText('送出'));
    expect(await screen.findByText('開始：11/5（週四）00:00')).toBeTruthy();
    expect(screen.queryByText(/整天/)).toBeNull();
  });

  test('按復原後最下面那行只是紀錄：沒有「重新回答」，上面 AI 的回答照樣有重新產生', async () => {
    const { store } = await screenWithCard();
    await fireEvent.press(screen.getByText('加入'));
    expect(await screen.findByText('好了')).toBeTruthy();
    await fireEvent.press(screen.getByText('復原'));
    expect(await screen.findByText('你按了復原：新增 1 個行程')).toBeTruthy();
    expect(screen.queryByText('重新回答')).toBeNull();
    expect(screen.getByText('重新產生')).toBeTruthy();
    // 就算叫到 retry 也不會把紀錄行和 AI 的回答刪掉
    await store.retry();
    expect(screen.getByText('好了')).toBeTruthy();
    expect(screen.getByText('你按了復原：新增 1 個行程')).toBeTruthy();
  });

  test('修改時間用時間選擇器：選了就照選的做；選填的結束時間可以拿掉再加上', async () => {
    const { cal } = await screenWithCard();
    await fireEvent.press(screen.getByText('修改'));
    // 日期、時間分開選（合成一個時 iPhone 量的寬度太寬，會擠出畫面）
    expect(screen.getByLabelText('開始日期').props.accessibilityHint).toBe('date');
    expect(screen.getByLabelText('開始時間').props.accessibilityHint).toBe('time');
    await fireEvent(screen.getByLabelText('開始日期'), 'valueChange', new Date(2026, 10, 5, 9, 0));
    await fireEvent(screen.getByLabelText('開始時間'), 'valueChange', new Date(2000, 0, 1, 16, 0));
    // 開始是必填，不能拿掉；結束可以
    expect(screen.getAllByText('拿掉')).toHaveLength(1);
    await fireEvent.press(screen.getByLabelText('拿掉結束'));
    expect(screen.queryByLabelText('結束日期')).toBeNull();
    // 加上：接在開始後一小時
    await fireEvent.press(screen.getByText('加上'));
    expect(screen.getByLabelText('結束時間').props.accessibilityHint).toBe('time');
    await fireEvent(screen.getByLabelText('結束時間'), 'valueChange', new Date(2000, 0, 1, 18, 30));
    await fireEvent.press(screen.getByText('加入'));
    await waitFor(() => expect(cal.created).toHaveLength(1));
    expect(cal.created[0]).toMatchObject({ start: '2026-11-05T16:00', end: '2026-11-05T18:30' });
  });

  test('修改開始時間：結束跟著移、保持長度；把結束改得比開始早，當場提示且不能加入', async () => {
    const { cal } = await screenWithCard();
    await fireEvent.press(screen.getByText('修改'));
    // 離開修改的按鈕叫「不改了」（「取消」會被誤會成取消整件事）
    expect(screen.getByText('不改了')).toBeTruthy();
    await fireEvent(screen.getByLabelText('開始時間'), 'valueChange', new Date(2000, 0, 1, 17, 0));
    expect(screen.getByLabelText('結束時間').props.value).toEqual(new Date(2026, 10, 4, 18, 0));
    await fireEvent(screen.getByLabelText('結束時間'), 'valueChange', new Date(2000, 0, 1, 16, 0));
    expect(screen.getByText('結束要比開始晚')).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent(screen.getByLabelText('結束時間'), 'valueChange', new Date(2000, 0, 1, 19, 0));
    expect(screen.queryByText('結束要比開始晚')).toBeNull();
    await fireEvent.press(screen.getByText('加入'));
    await waitFor(() => expect(cal.created).toHaveLength(1));
    expect(cal.created[0]).toMatchObject({ start: '2026-11-04T17:00', end: '2026-11-04T19:00' });
  });

  test('修改裡拿掉選填的欄位：真的拿掉，不會用回 AI 原本的值', async () => {
    const { cal, net } = await screenWithCard();
    await fireEvent.press(screen.getByText('修改'));
    await fireEvent.press(screen.getByLabelText('拿掉結束'));
    await fireEvent.press(screen.getByText('加入'));
    await waitFor(() => expect(cal.created).toHaveLength(1));
    expect(cal.created[0]).toEqual({ title: '帶小孩看牙醫', start: '2026-11-04T15:00' });
    await waitFor(() => expect(net.chatBodies()).toHaveLength(2));
    expect(JSON.parse(net.chatBodies()[1].messages.filter((m: any) => m.role === 'tool').at(-1).content).note).toContain('end: "2026-11-04T16:00" -> null');
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
    await screen.findByText('新增 1 個行程');
    expect(cal.created[0].title).toBe('看牙醫');
  });

  test('按不要：原因框不自動跳鍵盤；打完按鍵盤上的送出就送出', async () => {
    const { cal, net } = await screenWithCard();
    await fireEvent.press(screen.getByText('不要'));
    const box = screen.getByLabelText('要改成怎樣？（可以不填）');
    expect(box.props.autoFocus).toBeFalsy();
    expect(box.props.returnKeyType).toBe('send');
    await fireEvent.changeText(box, '改成週四');
    await fireEvent(box, 'submitEditing');
    expect(await screen.findByText('沒有做：加行程「帶小孩看牙醫」')).toBeTruthy();
    expect(cal.created).toEqual([]);
    await waitFor(() => expect(JSON.parse(net.chatBodies()[1].messages.at(-2).content).reason).toBe('改成週四'));
  });

  test('按不要可以說要改成怎樣', async () => {
    const { cal, net } = await screenWithCard();
    await fireEvent.press(screen.getByText('不要'));
    await fireEvent.changeText(screen.getByLabelText('要改成怎樣？（可以不填）'), '改成週四');
    await fireEvent.press(screen.getByText('送出'));
    expect(await screen.findByText('沒有做：加行程「帶小孩看牙醫」')).toBeTruthy();
    expect(cal.created).toEqual([]);
    await waitFor(() => expect(JSON.parse(net.chatBodies()[1].messages.at(-2).content).reason).toBe('改成週四'));
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

  test('按不回答：最後提醒模型使用者沒回答、不要自己假設（不是要它說「沒做」）', async () => {
    const { store, net } = await asked();
    await store.declineAction(pending(store)[0].id, '');
    await waitFor(() => expect(net.chatBodies()).toHaveLength(2));
    const last = net.chatBodies()[1].messages.at(-1);
    expect(last).toEqual({ role: 'system', content: expect.stringContaining('chose not to answer your question 「明天幾點提醒你？」') });
    expect(last.content).not.toContain('NOT done');
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
    await fireEvent.press(screen.getByText('自己輸入…'));
    await fireEvent.changeText(screen.getByLabelText('你的回答'), '中午');
    await fireEvent.press(screen.getByText('送出'));
    expect(await screen.findByText('你回答：中午')).toBeTruthy();
  });

  test('畫面：按不回答（可按範圍不蓋到旁邊的選項）', async () => {
    const { store } = await asked();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    // 按鈕間距 8、選項上下各補 8、左右各補 4：「不回答」換到第二排時，自己補的加上鄰居補的不能超過間距
    const slop = screen.getByRole('button', { name: '不回答' }).props.hitSlop;
    const option = screen.getByRole('button', { name: '早上 9:00' }).props.hitSlop;
    expect(slop.left + option.right).toBeLessThanOrEqual(8);
    expect(slop.top + option.bottom).toBeLessThanOrEqual(8);
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
    // 最後提醒：不要的是取消勾選的那件、改過的照改過的講；沒改的那件不提
    const note = net.chatBodies()[1].messages.at(-1);
    expect(note).toMatchObject({ role: 'system', content: expect.stringContaining('The user declined 「新增「親師座談會」」') });
    expect(note.content).toContain('what was actually done is 「新增「戶外教學（帶便當）」」');
    expect(note.content).not.toContain('校慶運動會');
  });

  test('接著回答時停掉、按了復原再「重新回答」：最後的提醒照樣寫取消勾選的那件沒做（復原的紀錄行不算）', async () => {
    const { store, host, net } = await three();
    const [a, b] = pending(store);
    // 接著回答時一直不回，按停止
    host.reply = () => ({ lines: [], hang: true });
    const p = store.approveActions([{ id: a.id }], [b.id, pending(store)[2].id]);
    await waitFor(() => expect(store.getState().streaming).not.toBeNull());
    store.stop();
    await p;
    await waitFor(() => expect(store.getState().messages.at(-1)).toMatchObject({ role: 'note', content: '已停止' }));
    await store.undoAction(a.id);
    script(host, [() => [text('好的'), done]]);
    await store.retry();
    await waitFor(() => expect(lastText(store)).toBe('好的'));
    const note = net.chatBodies().at(-1).messages.at(-1);
    expect(note.content).toContain('The user declined 「新增「親師座談會」」');
    expect(note.content).toContain('pressed Undo on 「新增「校慶運動會」」');
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

  test('畫面：改到一半主按鈕和別件的「修改」先按不了並說明；全部取消勾選時只剩「都不要」', async () => {
    const { store } = await three();
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.press(screen.getAllByText('修改')[0]);
    expect(screen.getByRole('button', { name: '加入 3 個' }).props.accessibilityState).toMatchObject({ disabled: true });
    // 直接換去改別件，前一件還沒按「好」的修改會不見
    const others = screen.getAllByRole('button', { name: '修改' });
    expect(others).toHaveLength(2);
    for (const b of others) expect(b.props.accessibilityState).toMatchObject({ disabled: true });
    // 提示寫的是畫面上真的有的按鈕
    expect(screen.getByText('先按「好」或「不改了」結束修改')).toBeTruthy();
    expect(screen.getByText('不改了')).toBeTruthy();
    await fireEvent.press(screen.getByText('好'));
    expect(screen.queryByText('先按「好」或「不改了」結束修改')).toBeNull();
    expect(screen.getAllByRole('button', { name: '修改' })[1].props.accessibilityState?.disabled).toBeFalsy();
    for (const name of [/校慶運動會/, /親師座談會/, /戶外教學/]) await fireEvent.press(screen.getByRole('checkbox', { name }));
    expect(screen.getByText('都不要')).toBeTruthy();
    expect(screen.queryByText('全部不要')).toBeNull();
  });
});
