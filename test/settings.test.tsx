import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
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

test('右邊的符號照 iOS 慣例：跳出選單 ⌃⌄、推進新的一頁 ›、直接執行的不放', async () => {
  await setup(jest.fn(async () => null));
  const row = (label: string | RegExp) => within(screen.getByLabelText(label));
  expect(row('語言，跟著系統').getByTestId('symbol-chevron.up.chevron.down', { includeHiddenElements: true })).toBeTruthy();
  expect(row(/^最近刪除/).getByTestId('symbol-chevron.right', { includeHiddenElements: true })).toBeTruthy();
  expect(row('備份所有對話').queryByTestId('symbol-chevron.right', { includeHiddenElements: true })).toBeNull();
  expect(row('從備份還原').queryByTestId('symbol-chevron.right', { includeHiddenElements: true })).toBeNull();
});

test('語言：預設跟著系統，可以改成 English', async () => {
  const { store } = await setup();
  expect(screen.getByLabelText('語言，跟著系統')).toBeTruthy();
  pickAction(2);
  await fireEvent.press(screen.getByLabelText('語言，跟著系統'));
  await waitFor(() => expect(store.getState().prefs.language).toBe('en'));
});

test('你的電腦：顯示數量，點了打開管理用的「你的電腦」；點一台只出選單、不直接切換；設定裡沒有已拿掉的項目', async () => {
  const { store } = await setup();
  for (const gone of ['AI 回答的語言', '自動幫對話取標題', '提示詞範本', '自訂指示']) expect(screen.queryByText(gone)).toBeNull();
  await fireEvent.press(screen.getByLabelText('你的電腦，1 台'));
  // 標題是「你的電腦」，下面才是「新增電腦」
  expect(await screen.findByText('新增電腦')).toBeTruthy();
  const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
  const before = store.getState().session?.hostUrl;
  await fireEvent.press(screen.getByLabelText(/^電腦 /));
  expect(sheet.mock.calls[0][0].options).toEqual(['改用這台電腦', '移除這台電腦', '取消']);
  expect(store.getState().session?.hostUrl).toBe(before);
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
