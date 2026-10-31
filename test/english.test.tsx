import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { setLanguage, t } from '../src/i18n';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 手機是英文時：整個 App 都是英文；也可以在設定裡改成中文

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

async function setup(device: 'en' | 'zh-Hant' = 'en') {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b', vision: true, think: 'toggle' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false, deviceLanguage: () => device });
  await store.init();
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  return { net, store };
}

afterEach(() => {
  jest.restoreAllMocks();
  setLanguage('zh-Hant');
});

test('英文手機：第一次打開就是英文', async () => {
  await setup();
  expect(screen.getAllByText(/Local AI/).length).toBeGreaterThan(0);
  expect(screen.getByText('Connect your computer')).toBeTruthy();
  expect(screen.getByText('Chats')).toBeTruthy();
  expect(screen.getAllByText('New chat')).toHaveLength(1); // 只有標題（右上角是用量）
});

test('英文手機：AI 用英文回答、用英文取標題', async () => {
  const { net, store } = await setup();
  await store.addHost('192.168.1.20');
  await store.send('hello');
  expect(net.chatBodies().at(-1).messages[0].content).toMatch(/^Please reply in English\.\n\n/);
  expect(net.titleBodies()[0].messages[0].content).toMatch(/^Write a title/);
});

test('英文：錯誤訊息、連線說明都是英文', async () => {
  const { net, store } = await setup();
  await store.addHost('192.168.1.20');
  net.hosts.get(A)!.online = false;
  await fireEvent.changeText(screen.getByLabelText('Message'), 'hi');
  await fireEvent.press(screen.getByLabelText('Send'));
  expect(await screen.findByText("No reply: Your phone isn't on Wi-Fi. Join the same Wi-Fi as the computer; away from home you need a tool like Tailscale.")).toBeTruthy();
  expect(screen.getByText('Retry')).toBeTruthy();
  await fireEvent.press(screen.getByText('Connection help'));
  expect(await screen.findByText('Ollama must be running on the computer.')).toBeTruthy();
});

test('在設定裡把語言改成繁體中文，畫面馬上變中文', async () => {
  await setup();
  await fireEvent.press(screen.getByLabelText('Chat list'));
  await fireEvent.press(await screen.findByText('Settings'));
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_o, cb) => cb(1));
  await fireEvent.press(screen.getByLabelText('Language, Use system setting'));
  expect(await screen.findByLabelText('語言，繁體中文')).toBeTruthy();
});

test('中文手機也可以在 App 裡改成英文', async () => {
  const { store } = await setup('zh-Hant');
  expect(screen.getByText('連接你的電腦')).toBeTruthy();
  await store.setPref('language', 'en');
  await waitFor(() => expect(screen.getByText('Connect your computer')).toBeTruthy());
});

test('英文：時間欄位讀螢幕的標籤唸起來通順（欄位名是 Starts、Remind at 這種，不能直接接 date）', () => {
  setLanguage('en');
  expect(t('{p0}日期', { p0: t('開始') })).toBe('Starts, date');
  expect(t('{p0}時間', { p0: t('什麼時候提醒') })).toBe('Remind at, time');
  expect(t('拿掉{p0}', { p0: t('結束') })).toBe('Remove the Ends field');
});

test('英文：最近刪除剩 1 天時用單數（不唸成 1 more days）', () => {
  setLanguage('en');
  expect(t('還會保留 1 天')).toBe('Kept for 1 more day');
  expect(t('已刪除的對話 {p0}，{p1}', { p0: 'Lunch', p1: t('還會保留 1 天') })).toBe('Deleted chat Lunch, Kept for 1 more day');
});
