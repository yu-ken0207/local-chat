import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Share } from 'react-native';

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

test('標題列顯示自動取的標題；對話清單列出所有對話，目前這段在最上面', async () => {
  await setup();
  expect(screen.getByLabelText('午餐，點一下打開對話設定')).toBeTruthy();
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

test('長按：匯出成 Markdown 分享', async () => {
  await setup();
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
  await fireEvent.press(screen.getByLabelText('對話清單'));
  pickAction(1);
  await fireEvent(await screen.findByLabelText('對話 天氣'), 'longPress');
  await waitFor(() => expect(share).toHaveBeenCalled());
  const arg = share.mock.calls[0][0] as { title: string; message: string };
  expect(arg.title).toBe('天氣');
  expect(arg.message).toContain('**你**：明天會下雨嗎');
});

test('長按：確認後刪除', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  pickAction(2);
  const alert = confirm();
  await fireEvent(await screen.findByLabelText('對話 天氣'), 'longPress');
  expect(alert.mock.calls[0][0]).toBe('刪除「天氣」？');
  await waitFor(() => expect(screen.queryByLabelText('對話 天氣')).toBeNull());
  expect((await store.listSessions()).map((s) => s.title)).toEqual(['午餐']);
});

test('清單裡的「新對話」', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.press(await screen.findByText('新對話'));
  await waitFor(() => expect(store.getState().messages).toEqual([]));
  expect(screen.getByLabelText('新對話，點一下打開對話設定')).toBeTruthy();
});

test('對話設定：設定角色後標題列有標記，送出時帶著角色', async () => {
  const { net, store } = await setup();
  await fireEvent.press(screen.getByLabelText('午餐，點一下打開對話設定'));
  await fireEvent.changeText(await screen.findByLabelText('角色設定'), '你是美食家');
  await fireEvent.changeText(screen.getByLabelText('對話標題'), '午餐計畫');
  await fireEvent.press(screen.getByText('完成'));
  await waitFor(() => expect(store.getState().session).toMatchObject({ title: '午餐計畫', systemPrompt: '你是美食家' }));
  expect(screen.getByText(/◆ 角色/)).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '晚餐呢');
  await fireEvent.press(screen.getByLabelText('送出'));
  await waitFor(() => expect(net.chatBodies().at(-1).messages[0]).toEqual({ role: 'system', content: '你是美食家' }));
});

test('對話設定：取消不會存', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('午餐，點一下打開對話設定'));
  await fireEvent.changeText(await screen.findByLabelText('角色設定'), '不要存');
  await fireEvent.press(screen.getByText('取消'));
  expect(store.getState().session?.systemPrompt).toBe('');
});

test('對話設定：刪除這段對話後切到另一段', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText('午餐，點一下打開對話設定'));
  confirm();
  await fireEvent.press(await screen.findByText('刪除這段對話'));
  await waitFor(() => expect(store.getState().session?.title).toBe('天氣'));
});

test('對話清單最下面顯示資料庫位置與大小，可以匯出整個資料庫', async () => {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  const db = Object.assign(memoryDb(), { path: '/var/mobile/Containers/Data/Application/X/Documents/SQLite/local-chat.db' });
  const store = new ChatStore({ repo: new Repo(db), client: net.client, wifiIp: async () => null, autoScan: false });
  await store.init();
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText('對話清單'));
  expect(await screen.findByText(/^local-chat\.db · \d+ KB$/)).toBeTruthy();
  expect(screen.getByLabelText('資料庫位置').props.children).toBe('/var/mobile/Containers/Data/Application/X/Documents/SQLite/local-chat.db');
  await fireEvent.press(screen.getByText('匯出資料庫'));
  const Sharing = require('expo-sharing');
  await waitFor(() =>
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///var/mobile/Containers/Data/Application/X/Documents/SQLite/local-chat.db', { dialogTitle: '匯出資料庫' })
  );
});

describe('使用者自己移除資料', () => {
  test('刪除所有對話：先確認，取消就不刪；確認後只剩一段新對話，主機保留', async () => {
    const { store } = await setup();
    await fireEvent.press(screen.getByLabelText('對話清單'));
    const cancel = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[0]?.onPress?.());
    await fireEvent.press(await screen.findByText('刪除所有對話'));
    expect(cancel.mock.calls[0][0]).toBe('刪除所有對話？');
    expect(cancel.mock.calls[0][1]).toContain('2 段對話');
    expect((await store.listSessions()).length).toBe(2);

    cancel.mockRestore();
    confirm();
    await fireEvent.press(screen.getByText('刪除所有對話'));
    await waitFor(() => expect(screen.getAllByLabelText(/^對話 /).map((r) => r.props.accessibilityLabel)).toEqual(['對話 新對話']));
    expect(store.getState().hosts).toHaveLength(1);
  });

  test('清除全部資料：確認後回到第一次打開的樣子', async () => {
    const { store } = await setup();
    await fireEvent.press(screen.getByLabelText('對話清單'));
    const alert = confirm();
    await fireEvent.press(await screen.findByText('清除全部資料'));
    expect(alert.mock.calls[0][0]).toBe('清除全部資料？');
    await waitFor(() => expect(store.getState().hosts).toEqual([]));
    await fireEvent.press(screen.getByText('完成'));
    expect(screen.getByText(/還沒有主機/)).toBeTruthy();
  });
});
