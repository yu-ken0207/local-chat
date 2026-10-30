import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { SettingsView } from '../src/components/SettingsSheet';
import { setLanguage } from '../src/i18n';
import { fmtEventTime } from '../src/lib/format';
import { ToolPermissionError, type PhoneTool } from '../src/lib/tools';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { calendarTools, type CalendarApi, type EventInfo, type NewEvent, type NewReminder } from '../src/tools/calendar';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 行事曆與提醒事項工具：用假的行事曆測，不用真的手機

const NOW = new Date(2026, 9, 29, 16, 40).getTime();
const ctx = { now: NOW };
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

class FakeCalendar implements CalendarApi {
  calendarOk = true;
  remindersOk = true;
  list = [
    { id: 'home', title: '家庭', canWrite: true },
    { id: 'work', title: 'Work', canWrite: true },
    { id: 'holidays', title: '節日', canWrite: false },
  ];
  defaultId: string | null = 'home';
  stored: EventInfo[] = [];
  created: { calendarId: string; event: NewEvent }[] = [];
  reminders: NewReminder[] = [];
  deleted: string[] = [];
  allowCalendar = async () => this.calendarOk;
  allowReminders = async () => this.remindersOk;
  calendars = async () => this.list;
  defaultCalendarId = async () => this.defaultId;
  events = async (ids: string[], start: Date, end: Date) => this.stored.filter((e) => ids.includes(e.calendarId) && e.start >= start && e.start < end);
  createEvent = async (calendarId: string, event: NewEvent) => {
    this.created.push({ calendarId, event });
    return `e${this.created.length}`;
  };
  deleteEvent = async (id: string) => void this.deleted.push(id);
  createReminder = async (r: NewReminder) => {
    this.reminders.push(r);
    return `r${this.reminders.length}`;
  };
  deleteReminder = async (id: string) => void this.deleted.push(id);
}

function tools(api = new FakeCalendar()) {
  const list = calendarTools(api);
  const by = (name: string) => list.find((x) => x.name === name)!;
  return { api, list, listEvents: by('list_events'), createEvent: by('create_event'), createReminder: by('create_reminder'), listCalendars: by('list_calendars') };
}

afterEach(() => setLanguage('zh-Hant'));

describe('時間的白話', () => {
  test('中文、英文、整天、跨天', () => {
    expect(fmtEventTime(at(2026, 11, 4, 15), at(2026, 11, 4, 16), false, 'zh-Hant')).toBe('11/4（週三）15:00–16:00');
    expect(fmtEventTime(at(2026, 11, 4, 15), at(2026, 11, 4, 16), false, 'en')).toBe('Wed 11/4 15:00–16:00');
    expect(fmtEventTime(at(2026, 11, 20), null, true, 'zh-Hant')).toBe('11/20（週五）');
    expect(fmtEventTime(at(2026, 11, 4, 22), at(2026, 11, 5, 1), false, 'zh-Hant')).toBe('11/4（週三）22:00–11/5（週四）01:00');
  });
});

describe('看行事曆', () => {
  test('只回最多 10 筆、照時間排、帶行事曆名稱，多的說還有幾筆', async () => {
    const { api, listEvents } = tools();
    api.stored = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, title: `會議 ${12 - i}`, start: at(2026, 11, 4, 20 - i), end: at(2026, 11, 4, 21 - i), allDay: false, calendarId: 'work' }));
    api.stored.push({ id: 'all', title: '校慶', start: at(2026, 11, 4), end: at(2026, 11, 5), allDay: true, calendarId: 'home' });
    const out = await listEvents.run({ start: '2026-11-04' });
    const data = out.data as { events: any[]; more: number };
    expect(data.events).toHaveLength(10);
    expect(data.more).toBe(3);
    expect(data.events[0]).toEqual({ title: '校慶', start: '2026-11-04', end: undefined, allDay: true, calendar: '家庭' });
    expect(data.events[1]).toMatchObject({ title: '會議 1', start: '2026-11-04T09:00', end: '2026-11-04T10:00', calendar: 'Work' });
    expect(out.summary).toBe('看了行事曆（13 筆）');
  });

  test('日期範圍不合理就退回；沒給權限丟權限錯誤', async () => {
    const { api, listEvents } = tools();
    expect(listEvents.check!({ start: '2026-11-04', end: '2026-11-01' }, ctx)).toContain('before start');
    expect(listEvents.check!({ start: '2026-11-01', end: '2027-03-01' }, ctx)).toContain('two months');
    api.calendarOk = false;
    await expect(listEvents.run({ start: '2026-11-04' })).rejects.toBeInstanceOf(ToolPermissionError);
  });

  test('有哪些行事曆：只列可以加行程的', async () => {
    const { listCalendars } = tools();
    expect((await listCalendars.run({})).data).toEqual(['家庭', 'Work']);
  });

  test('同一個行程同步在兩個行事曆：只算一筆', async () => {
    const { api, listEvents } = tools();
    const e = { title: 'D200 部門會議', start: at(2026, 11, 2, 14), end: at(2026, 11, 2, 15), allDay: false };
    api.stored = [{ ...e, id: 'a', calendarId: 'home' }, { ...e, id: 'b', calendarId: 'work' }];
    const out = await listEvents.run({ start: '2026-11-02' });
    expect((out.data as { events: unknown[] }).events).toHaveLength(1);
    expect(out.summary).toBe('看了行事曆（1 筆）');
  });
});

describe('加行程', () => {
  test('沒說結束時間：補開始後 1 小時並標成猜的；整天的不補', () => {
    const { createEvent } = tools();
    expect(createEvent.fillDefaults!({ title: 'a', start: '2026-11-04T15:00' }, ctx)).toEqual({ input: { title: 'a', start: '2026-11-04T15:00', end: '2026-11-04T16:00' }, guessed: ['end'] });
    expect(createEvent.fillDefaults!({ title: 'a', start: '2026-11-20T00:00', allDay: true }, ctx).guessed).toEqual([]);
  });

  test('時間在過去、超過一年、結束比開始早都退回', () => {
    const { createEvent } = tools();
    expect(createEvent.check!({ title: 'a', start: '2026-10-01T09:00' }, ctx)).toContain('in the past');
    expect(createEvent.check!({ title: 'a', start: '2027-12-01T09:00' }, ctx)).toContain('more than a year');
    expect(createEvent.check!({ title: 'a', start: '2026-11-04T15:00', end: '2026-11-04T14:00' }, ctx)).toContain('after start');
    expect(createEvent.check!({ title: 'a', start: '2026-11-04T15:00' }, ctx)).toBeNull();
  });

  test('確認卡上的一句話：中文英文都有星期', () => {
    const { createEvent } = tools();
    const input = { title: '帶小孩看牙醫', start: '2026-11-04T15:00', end: '2026-11-04T16:00', calendar: '家庭', alertMinutesBefore: 30 };
    expect(createEvent.describe!(input)).toBe('在 11/4（週三）15:00–16:00 新增「帶小孩看牙醫」到「家庭」行事曆，提前 30 分鐘提醒');
    setLanguage('en');
    expect(createEvent.describe!({ title: 'Dentist', start: '2026-11-04T15:00', end: '2026-11-04T16:00' })).toBe('Add “Dentist” on Wed 11/4 15:00–16:00 to your default calendar');
    expect(createEvent.verb).toBe('Add');
  });

  test('加到預設的行事曆、或照名稱找（不分大小寫）；找不到就說；可以復原', async () => {
    const { api, createEvent } = tools();
    const out = await createEvent.run({ title: '看牙醫', start: '2026-11-04T15:00', end: '2026-11-04T16:00', alertMinutesBefore: 30 });
    expect(api.created[0]).toMatchObject({ calendarId: 'home', event: { title: '看牙醫', start: at(2026, 11, 4, 15), end: at(2026, 11, 4, 16), allDay: false, alertMinutes: 30 } });
    expect(out).toEqual({ data: { id: 'e1', title: '看牙醫', start: '2026-11-04T15:00', end: '2026-11-04T16:00', calendar: '家庭' }, summary: '新增行程「看牙醫」' });
    await createEvent.run({ title: '開會', start: '2026-11-05T10:00', calendar: 'work' });
    expect(api.created[1].calendarId).toBe('work');
    await expect(createEvent.run({ title: 'x', start: '2026-11-05T10:00', calendar: '節日' })).rejects.toThrow('找不到');
    await createEvent.undo!(out.data);
    expect(api.deleted).toEqual(['e1']);
  });
});

describe('加提醒', () => {
  test('有時間、沒時間；可以復原；沒給權限丟權限錯誤', async () => {
    const { api, createReminder } = tools();
    expect(createReminder.describe!({ title: '繳電費', due: '2026-10-30T09:00' })).toBe('10/30（週五）09:00 提醒你「繳電費」');
    expect(createReminder.describe!({ title: '買牛奶' })).toBe('在「提醒事項」加一項「買牛奶」');
    const out = await createReminder.run({ title: '繳電費', due: '2026-10-30T09:00' });
    expect(api.reminders[0]).toEqual({ title: '繳電費', due: at(2026, 10, 30, 9) });
    expect(out.summary).toBe('新增提醒「繳電費」');
    await createReminder.undo!(out.data);
    expect(api.deleted).toEqual(['r1']);
    api.remindersOk = false;
    await expect(createReminder.run({ title: 'x' })).rejects.toBeInstanceOf(ToolPermissionError);
  });
});

describe('接上 App', () => {
  const A = 'http://192.168.1.20:11434';
  const toolCall = (name: string, args: unknown) => ({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name, arguments: args } }] }, done: false });
  const done = { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' };

  async function setup(api = new FakeCalendar(), list?: PhoneTool[]) {
    const net = new FakeOllamaNet();
    const host = net.addHost(A, { models: [{ name: 'gemma4:12b', tools: true }] });
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false, tools: list ?? calendarTools(api), now: () => NOW });
    await store.init();
    await store.addHost('192.168.1.20');
    await store.loadModels(A);
    await store.selectModel(A, 'gemma4:12b');
    return { net, host, store, api };
  }

  test('沒給行事曆權限：畫面說明並給「打開設定」，模型收到 permission_denied', async () => {
    const api = new FakeCalendar();
    api.calendarOk = false;
    const { net, host, store } = await setup(api);
    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('list_events', { start: '2026-11-04' }), done] : [{ message: { role: 'assistant', content: '請先打開權限' }, done: false }, done] });
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '11/4 有什麼行程');
    await fireEvent.press(screen.getByLabelText('送出'));
    expect(await screen.findByText(/沒有行事曆的權限/)).toBeTruthy();
    await screen.findByText('請先打開權限');
    expect(JSON.parse(net.chatBodies()[1].messages.at(-1).content).error).toContain('permission_denied');
    await fireEvent.press(screen.getByText('打開設定'));
    expect(open).toHaveBeenCalled();
    open.mockRestore();
  });

  test('AI 填的備註會顯示在卡片上，修改裡也能拿掉', async () => {
    const { host, store, api } = await setup();
    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('create_event', { title: '戶外教學', start: '2026-11-20', allDay: true, notes: '請攜帶午餐與水壺' }), done] : [{ message: { role: 'assistant', content: '好了' }, done: false }, done] });
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '11/20 戶外教學');
    await fireEvent.press(screen.getByLabelText('送出'));
    expect(await screen.findByText('備註：請攜帶午餐與水壺')).toBeTruthy();
    await fireEvent.press(screen.getByText('修改'));
    await fireEvent.changeText(screen.getByLabelText('備註'), '');
    await fireEvent.press(screen.getByText('加入'));
    await waitFor(() => expect(api.created).toHaveLength(1));
    expect(api.created[0].event.notes).toBeUndefined();
  });

  test('提醒按修改、拿掉時間：設成沒有時間的提醒（不會用回 AI 原本的時間）', async () => {
    const { host, store, api } = await setup();
    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('create_reminder', { title: '繳電費', due: '2026-10-31T09:00' }), done] : [{ message: { role: 'assistant', content: '好了' }, done: false }, done] });
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '提醒我明天九點繳電費');
    await fireEvent.press(screen.getByLabelText('送出'));
    await fireEvent.press(await screen.findByText('修改'));
    await fireEvent.press(screen.getByLabelText('拿掉什麼時候提醒'));
    await fireEvent.press(screen.getByText('設提醒'));
    await waitFor(() => expect(api.reminders).toHaveLength(1));
    expect(api.reminders[0]).toEqual({ title: '繳電費' });
  });

  test('全天的行程按修改：時間選擇器只選日期，選了就是那天的全天', async () => {
    const { host, store, api } = await setup();
    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('create_event', { title: '戶外教學', start: '2026-11-20', allDay: true }), done] : [{ message: { role: 'assistant', content: '好了' }, done: false }, done] });
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '11/20 戶外教學');
    await fireEvent.press(screen.getByLabelText('送出'));
    await fireEvent.press(await screen.findByText('修改'));
    expect(screen.getByLabelText('開始日期').props.accessibilityHint).toBe('date');
    expect(screen.queryByLabelText('開始時間')).toBeNull();
    await fireEvent(screen.getByLabelText('開始日期'), 'valueChange', new Date(2026, 10, 27, 13, 45));
    await fireEvent.press(screen.getByText('加入'));
    await waitFor(() => expect(api.created).toHaveLength(1));
    expect(api.created[0].event).toMatchObject({ title: '戶外教學', allDay: true, start: at(2026, 11, 27) });
  });

  test('設定裡關掉了，模型照前面的對話還是去叫：不出確認卡，跟模型說關掉了，畫面寫一行', async () => {
    const { net, host, store } = await setup();
    await store.setToolGroup('calendar', false);
    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('create_event', { title: '戶外教學', start: '2026-11-20', allDay: true }), done] : [{ message: { role: 'assistant', content: '行事曆在設定裡關掉了' }, done: false }, done] });
    await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '試試看');
    await fireEvent.press(screen.getByLabelText('送出'));
    expect(await screen.findByText('行事曆在設定裡關掉了')).toBeTruthy();
    expect(screen.getByText('沒有做：「看行事曆、加行程」在設定裡關掉了')).toBeTruthy();
    expect(store.getState().messages.flatMap((m) => m.actions ?? [])).toEqual([]);
    const [first, second] = net.chatBodies();
    expect(first.tools.map((x: any) => x.function.name)).toEqual(['create_reminder', 'ask_user']);
    expect(first.messages[0].content).toContain('turned off these');
    expect(JSON.parse(second.messages.at(-1).content).error).toContain('create_event is turned off');
  });

  test('全部關掉：不送工具，但模型還是叫了也要接住，不會變成空的回答', async () => {
    const { net, host, store } = await setup();
    await store.setToolGroup('calendar', false);
    await store.setToolGroup('reminders', false);
    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('create_event', { title: '戶外教學', start: '2026-11-20', allDay: true }), done] : [{ message: { role: 'assistant', content: '都關掉了' }, done: false }, done] });
    await store.send('幫我加入日曆');
    await waitFor(() => expect(store.getState().messages.at(-1)?.content).toBe('都關掉了'));
    const [first, second] = net.chatBodies();
    expect(first.tools).toBeUndefined();
    expect(first.messages[0].content).toContain('turned off these');
    expect(JSON.parse(second.messages.at(-1).content).error).toContain('turned off');
  });

  test('設定裡關掉「加提醒事項」：不給模型提醒工具；做過的事可以在設定裡復原', async () => {
    const { net, host, store, api } = await setup();
    expect(store.toolGroups()).toEqual(['calendar', 'reminders']);
    await render(<SettingsView store={store} onClose={jest.fn()} onOpenTrash={jest.fn()} copyText={jest.fn()} />);
    expect(screen.getByText('AI 可以做的事')).toBeTruthy();
    await fireEvent(screen.getByLabelText('加提醒事項'), 'valueChange', false);
    await waitFor(() => expect(store.getState().prefs.toolsOff).toEqual(['reminders']));

    let n = 0;
    host.reply = () => ({ lines: n++ === 0 ? [toolCall('create_event', { title: '看牙醫', start: '2026-11-04T15:00' }), done] : [{ message: { role: 'assistant', content: '好了' }, done: false }, done] });
    await store.send('加行程');
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(net.chatBodies()[0].tools.map((x: any) => x.function.name)).toEqual(['list_calendars', 'list_events', 'create_event', 'ask_user']);
    const action = store.getState().messages.flatMap((m) => m.actions ?? [])[0];
    await store.approveAction(action.id);
    await waitFor(() => expect(api.created).toHaveLength(1));

    await fireEvent.press(screen.getByText('做過的事'));
    expect(await screen.findByText('新增行程「看牙醫」')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('復原：新增行程「看牙醫」'));
    await waitFor(() => expect(api.deleted).toEqual(['e1']));
    expect(await screen.findByText(/已復原/)).toBeTruthy();
  });
});
