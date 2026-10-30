import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

/** 準備兩段對話：「午餐」（目前這段）與「天氣」 */
async function setup() {
  const net = new FakeOllamaNet();
  const host = net.addHost(A, { models: [{ name: 'gemma4:31b', vision: true }] });
  const titles = ['天氣', '午餐'];
  host.titleReply = () => ({ lines: [{ message: { content: titles.shift() ?? '其他' }, done: false }, { message: { content: '' }, done: true }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5 });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  await store.send('明天會下雨嗎');
  await store.titleTask;
  await store.newSession();
  await store.send('中午吃牛肉麵好嗎');
  await store.titleTask;
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  return { net, store };
}

const pickAction = (index: number) => jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_o, cb) => cb(index));
const confirm = () => jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());

afterEach(() => jest.restoreAllMocks());

async function openSettings() {
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.press(await screen.findByText('設定'));
}

test('標題列顯示自動取的標題；對話清單列出所有對話，目前這段在最上面', async () => {
  await setup();
  expect(screen.getByLabelText('午餐，點一下可以改名或刪除')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  const rows = await screen.findAllByLabelText(/^對話 /);
  expect(rows.map((r) => r.props.accessibilityLabel)).toEqual(['對話 午餐', '對話 天氣']);
  expect(rows[0].props.accessibilityState.selected).toBe(true);
});

test('搜尋內容只留下符合的對話；點一下切換過去', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.changeText(await screen.findByLabelText('搜尋對話'), '下雨');
  // 清單剛打開時還沒載入，要等到「天氣」出現、「午餐」被篩掉才算搜尋完成
  await waitFor(() => {
    expect(screen.getByLabelText('對話 天氣')).toBeTruthy();
    expect(screen.queryByLabelText('對話 午餐')).toBeNull();
  });
  await fireEvent.press(screen.getByLabelText('對話 天氣'));
  await waitFor(() => expect(store.getState().session?.title).toBe('天氣'));
  expect(screen.getByText('明天會下雨嗎')).toBeTruthy();
});

test('搜尋不到時顯示提示', async () => {
  await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.changeText(await screen.findByLabelText('搜尋對話'), '火星');
  expect(await screen.findByText('沒有符合的對話')).toBeTruthy();
});

test('長按：重新命名', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  pickAction(0);
  jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('明天天氣'));
  await fireEvent(await screen.findByLabelText('對話 天氣'), 'longPress');
  expect(await screen.findByLabelText('對話 明天天氣')).toBeTruthy();
  expect((await store.listSessions()).map((s) => s.title)).toContain('明天天氣');
});

test('長按刪除：不用先確認，可以馬上復原', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  pickAction(1);
  const alert = jest.spyOn(Alert, 'alert');
  await fireEvent(await screen.findByLabelText('對話 天氣'), 'longPress');
  expect(alert).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByLabelText('對話 天氣')).toBeNull());
  expect((await store.listSessions()).map((s) => s.title)).toEqual(['午餐']);
  await fireEvent.press(await screen.findByText('復原'));
  expect(await screen.findByLabelText('對話 天氣')).toBeTruthy();
});

test('最近刪除：可以救回、永久刪除（先確認）、全部清空（先確認）', async () => {
  const { store } = await setup();
  const ids = (await store.listSessions()).map((s) => s.id);
  await store.deleteSession(ids[0]);
  await store.deleteSession(ids[1]);
  await store.dismissUndo();
  await openSettings();
  await fireEvent.press(await screen.findByLabelText('最近刪除，2 段'));
  expect(await screen.findByLabelText('已刪除的對話 天氣，還會保留 30 天')).toBeTruthy();
  expect(screen.getAllByText('還會保留 30 天')).toHaveLength(2);

  // 「救回」是真的按鈕：按了直接救回，不跳選單
  await fireEvent.press(screen.getByLabelText('救回 天氣'));
  await waitFor(() => expect(screen.queryByLabelText(/已刪除的對話 天氣/)).toBeNull());
  expect((await store.listSessions()).map((s) => s.title)).toContain('天氣');

  pickAction(1);
  const alert = confirm();
  await fireEvent.press(screen.getByLabelText(/已刪除的對話 午餐/));
  expect(alert.mock.calls[0][0]).toBe('永久刪除「午餐」？');
  await waitFor(() => expect(screen.getByText(/最近刪除是空的/)).toBeTruthy());

  await fireEvent.press(screen.getByLabelText('返回設定'));
  // 關上設定回到對話清單，救回的對話在清單裡
  await fireEvent.press(await screen.findByText('完成'));
  expect(await screen.findByLabelText('對話 天氣')).toBeTruthy();
});

test('最近刪除：VoiceOver 用動作救回、永久刪除（整列合成一個元素，裡面的「救回」摸不到）', async () => {
  const { store } = await setup();
  const ids = (await store.listSessions()).map((s) => s.id);
  await store.deleteSession(ids[0]);
  await store.deleteSession(ids[1]);
  await store.dismissUndo();
  await openSettings();
  await fireEvent.press(await screen.findByLabelText('最近刪除，2 段'));
  const row = await screen.findByLabelText('已刪除的對話 天氣，還會保留 30 天');
  expect(row.props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(['restore', 'delete']);
  await fireEvent(row, 'accessibilityAction', { nativeEvent: { actionName: 'restore' } });
  await waitFor(() => expect(screen.queryByLabelText(/已刪除的對話 天氣/)).toBeNull());
  expect((await store.listSessions()).map((s) => s.title)).toContain('天氣');
});

test('最近刪除：全部救回；全部清空在清單下面（標題列右邊不放危險按鈕）', async () => {
  const { store } = await setup();
  const ids = (await store.listSessions()).map((s) => s.id);
  await store.deleteSession(ids[0]);
  await store.deleteSession(ids[1]);
  await store.dismissUndo();
  await openSettings();
  await fireEvent.press(await screen.findByLabelText('最近刪除，2 段'));
  expect(await screen.findByText('全部清空')).toBeTruthy();
  await fireEvent.press(screen.getByText('全部救回'));
  await waitFor(() => expect(screen.getByText(/最近刪除是空的/)).toBeTruthy());
  expect(screen.queryByText('全部清空')).toBeNull();
  expect((await store.listTrash()).length).toBe(0);
});

test('清單裡的「新對話」', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.press(await screen.findByLabelText('開始新對話'));
  await waitFor(() => expect(store.getState().messages).toEqual([]));
  expect(screen.getByTestId('chat-title').props.children).toBe('新對話');
});

test('點標題：可以改名；新對話沒內容時點了沒反應', async () => {
  const { store } = await setup();
  pickAction(0);
  jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('午餐計畫'));
  await fireEvent.press(screen.getByLabelText('午餐，點一下可以改名或刪除'));
  await waitFor(() => expect(store.getState().session?.title).toBe('午餐計畫'));
  expect(screen.getByLabelText('午餐計畫，點一下可以改名或刪除')).toBeTruthy();

  await store.newSession();
  const sheet = pickAction(0);
  sheet.mockClear();
  await fireEvent.press(await screen.findByTestId('chat-title'));
  expect(sheet).not.toHaveBeenCalled();
});

test('點標題：刪除這段對話，不用先確認，切到另一段，可以復原', async () => {
  const { store } = await setup();
  pickAction(2);
  const alert = jest.spyOn(Alert, 'alert');
  await fireEvent.press(screen.getByLabelText('午餐，點一下可以改名或刪除'));
  await waitFor(() => expect(store.getState().session?.title).toBe('天氣'));
  expect(alert).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByText('復原'));
  await waitFor(async () => expect((await store.listSessions()).map((s) => s.title).sort()).toEqual(['午餐', '天氣']));
});

test('設定 > 進階：資料庫位置與大小；資料 > 備份所有對話', async () => {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  const db = Object.assign(memoryDb(), { path: '/var/mobile/Containers/Data/Application/X/Documents/SQLite/local-chat.db' });
  const store = new ChatStore({ repo: new Repo(db), client: net.client, wifiIp: async () => null, autoScan: false });
  await store.init();
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  await openSettings();
  expect(await screen.findByText(/^資料庫：local-chat\.db · \d+ KB$/)).toBeTruthy();
  expect(screen.getByLabelText('資料庫位置').props.children).toBe('/var/mobile/Containers/Data/Application/X/Documents/SQLite/local-chat.db');
  await fireEvent.press(screen.getByText('備份所有對話'));
  const Sharing = require('expo-sharing');
  await waitFor(() =>
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///var/mobile/Containers/Data/Application/X/Documents/SQLite/local-chat.db', { dialogTitle: '備份所有對話' })
  );
});

describe('使用者自己移除資料', () => {
  test('刪除所有對話：不用先確認；只剩一段新對話，主機保留；可以復原', async () => {
    const { store } = await setup();
    await openSettings();
    const alert = jest.spyOn(Alert, 'alert');
    await fireEvent.press(await screen.findByText('刪除所有對話'));
    expect(alert).not.toHaveBeenCalled();
    await waitFor(async () => expect((await store.listSessions()).map((s) => s.title)).toEqual(['']));
    expect(store.getState().hosts).toHaveLength(1);
    expect(screen.getByText('已刪除 2 段對話')).toBeTruthy();
    await fireEvent.press(screen.getByText('復原'));
    await waitFor(async () => expect((await store.listSessions()).map((s) => s.title).sort()).toEqual(['午餐', '天氣']));
  });

  test('清除全部資料：先確認；之後幾秒內可以復原', async () => {
    const { store } = await setup();
    await openSettings();
    const alert = confirm();
    await fireEvent.press(await screen.findByText('清除全部資料'));
    expect(alert.mock.calls[0][0]).toBe('清除全部資料？');
    await waitFor(() => expect(store.getState().hosts).toEqual([]));
    await fireEvent.press(screen.getByText('復原'));
    await waitFor(() => expect(store.getState().hosts).toHaveLength(1));
    await store.resetAll();
    await store.dismissUndo();
    await fireEvent.press(screen.getByText('完成'));
    await fireEvent.press(await screen.findByLabelText('關閉對話清單'));
    expect(await screen.findByText('連接你的電腦')).toBeTruthy();
  });
});
