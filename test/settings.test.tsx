import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import type { Db } from '../src/store/db';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

async function setup(pickBackup?: () => Promise<Db | null>) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b', vision: true }] });
  const store = new ChatStore({
    repo: new Repo(memoryDb()),
    client: net.client,
    wifiIp: async () => null,
    throttleMs: 5,
    autoScan: false,
    deviceLanguage: () => 'zh-Hant',
    openMemoryDb: async () => memoryDb(),
  });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.send('現在的對話');
  await store.titleTask;
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} pickBackup={pickBackup} />);
  await fireEvent.press(screen.getByLabelText('對話清單'));
  await fireEvent.press(await screen.findByText('設定'));
  return { net, store };
}

const pickAction = (index: number) => jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_o, cb) => cb(index));

afterEach(() => jest.restoreAllMocks());

test('語言：預設跟著系統，可以改成 English', async () => {
  const { store } = await setup();
  expect(screen.getByLabelText('語言，跟著系統')).toBeTruthy();
  pickAction(2);
  await fireEvent.press(screen.getByLabelText('語言，跟著系統'));
  await waitFor(() => expect(store.getState().prefs.language).toBe('en'));
});

test('AI 回答的語言：可以選「不指定」', async () => {
  const { store } = await setup();
  pickAction(3);
  await fireEvent.press(screen.getByLabelText('AI 回答的語言，跟著 App 語言'));
  await waitFor(() => expect(store.getState().prefs.replyLanguage).toBe('any'));
  expect(screen.getByLabelText('AI 回答的語言，不指定')).toBeTruthy();
});

test('自動取標題可以關掉', async () => {
  const { store } = await setup();
  await fireEvent(screen.getByLabelText('自動幫對話取標題'), 'valueChange', false);
  await waitFor(() => expect(store.getState().prefs.autoTitle).toBe(false));
});

test('你的電腦、提示詞範本：顯示數量，點了打開管理面板', async () => {
  await setup();
  await fireEvent.press(screen.getByLabelText('你的電腦，1 台'));
  expect(await screen.findByText('連接你的電腦')).toBeTruthy();
  await fireEvent.press(screen.getAllByText('完成').at(-1)!);
  await fireEvent.press(screen.getByLabelText('提示詞範本，6 個'));
  expect(await screen.findByText('新增範本')).toBeTruthy();
});

test('從備份還原：先確認，還原後資料換掉，可以復原', async () => {
  const backupDb = memoryDb();
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  const other = new ChatStore({ repo: new Repo(backupDb), client: net.client, wifiIp: async () => null, autoScan: false });
  await other.init();
  await other.addHost('192.168.1.20');
  await other.send('備份裡的對話');

  const { store } = await setup(async () => backupDb);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
  await fireEvent.press(screen.getByText('從備份還原'));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  expect(alert.mock.calls[0][0]).toBe('用備份取代目前的資料？');
  await waitFor(() => expect(store.getState().messages[0]?.content).toBe('備份裡的對話'));
  await fireEvent.press(await screen.findByText('復原'));
  await waitFor(() => expect(store.getState().messages[0]?.content).toBe('現在的對話'));
});

test('從備份還原：選到不是備份的檔案，說明原因，資料不動', async () => {
  const bad = memoryDb();
  await bad.exec('CREATE TABLE notes (id INTEGER)');
  const { store } = await setup(async () => bad);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
  await fireEvent.press(screen.getByText('從備份還原'));
  await waitFor(() => expect(alert.mock.calls.some((c) => c[0] === '沒有還原')).toBe(true));
  expect(alert.mock.calls.find((c) => c[0] === '沒有還原')![1]).toBe('這個檔案不是這個 App 的備份。');
  expect(store.getState().messages[0].content).toBe('現在的對話');
});

test('從備份還原：沒選檔案就什麼都不做', async () => {
  const { store } = await setup(async () => null);
  const alert = jest.spyOn(Alert, 'alert');
  await fireEvent.press(screen.getByText('從備份還原'));
  expect(alert).not.toHaveBeenCalled();
  expect(store.getState().messages[0].content).toBe('現在的對話');
});

test('關於：顯示 App 名稱與版本', async () => {
  await setup();
  expect(screen.getByText(/版本 1\.0\.0/)).toBeTruthy();
});
