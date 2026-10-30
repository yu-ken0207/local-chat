import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, ScrollView } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 討論串：針對某一題另開的小對話，掛在原本那段對話底下（像 Discord 的討論串）

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

/** 一段對話裡聊了兩個主題 */
async function setup() {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  await store.send('台南有什麼小吃');
  await store.send('Go 怎麼裝');
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={jest.fn()} />);
  return { net, store };
}

/** 長按選單：記下出現的選項，照字選一項（給 null 就按取消） */
function menu(label: string | null) {
  const seen: string[][] = [];
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => {
    seen.push(o.options);
    cb(label === null ? o.options.length - 1 : o.options.indexOf(label));
  });
  return seen;
}

const longPress = (id: string) => fireEvent(screen.getByTestId(`message-${id}`), 'longPress');

afterEach(() => jest.restoreAllMocks());

test('長按回答選「開討論串」：只帶這一題；問一題再回到對話，那一題下面有「討論串（1 則）」，點了回到同一個', async () => {
  const { store } = await setup();
  const answer = store.getState().messages[1];
  menu('開討論串');
  await longPress(answer.id);
  expect(await screen.findByText('以下是討論串')).toBeTruthy();
  expect(screen.getByTestId('chat-title').props.children).toBe('討論串');
  expect(screen.getByText('台南有什麼小吃')).toBeTruthy();
  expect(screen.queryByText('Go 怎麼裝')).toBeNull();
  // 帶進來的那一題只是背景：下面沒有「重新產生」
  expect(screen.queryByText('重新產生')).toBeNull();

  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '牛肉湯哪家好');
  await fireEvent.press(screen.getByLabelText('送出'));
  expect(await screen.findByText('回答：牛肉湯哪家好')).toBeTruthy();
  await waitFor(() => expect(store.getState().streaming).toBeNull());

  // 點卡片外面模糊的地方：卡片縮回去，回到原對話
  await fireEvent.press(screen.getByTestId('thread-backdrop', { includeHiddenElements: true }));
  expect(await screen.findByText('討論串（1 則）', {}, { timeout: 3000 })).toBeTruthy();
  expect(screen.getByText('Go 怎麼裝')).toBeTruthy();
  expect(screen.queryByText('回答：牛肉湯哪家好')).toBeNull();

  await fireEvent.press(screen.getByLabelText('討論串，問了 1 次，點一下打開'));
  expect(await screen.findByText('回答：牛肉湯哪家好')).toBeTruthy();
});

test('討論串裡長按：沒有「開討論串」（只有一層）；帶進來的那一題只能複製', async () => {
  const { store } = await setup();
  await act(async () => {
    await store.openThread(store.getState().messages[0].id);
  });
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '牛肉湯哪家好');
  await fireEvent.press(screen.getByLabelText('送出'));
  await waitFor(() => expect(store.getState().streaming).toBeNull());
  const [rootQuestion, , , followUp] = store.getState().messages;
  const seen = menu(null);
  await longPress(followUp.id);
  await longPress(rootQuestion.id);
  expect(seen[0]).not.toContain('開討論串');
  expect(seen[0]).toContain('重新產生');
  expect(seen[1]).toEqual(['複製', '取消']);
});

test('已經有討論串的那一題：長按寫「打開討論串」', async () => {
  const { store } = await setup();
  const [question, answer] = store.getState().messages;
  await act(async () => {
    await store.openThread(question.id);
  });
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '牛肉湯哪家好');
  await fireEvent.press(screen.getByLabelText('送出'));
  await waitFor(() => expect(store.getState().streaming).toBeNull());
  await fireEvent.press(screen.getByLabelText('關閉討論串'));
  await screen.findByText('討論串（1 則）', {}, { timeout: 3000 });
  const seen = menu(null);
  await longPress(answer.id);
  expect(seen[0]).toContain('打開討論串');
  expect(seen[0]).not.toContain('開討論串');
});

test('從討論串回到對話：回到剛才看的位置，不是捲到最底', async () => {
  const { store } = await setup();
  const list = screen.getByTestId('transcript');
  const at = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: 2000 }, layoutMeasurement: { width: 390, height: 600 } } });
  await fireEvent(list, 'scrollBeginDrag', at(300));
  await fireEvent(list, 'scroll', at(300));
  await fireEvent(list, 'scrollEndDrag', at(300));
  menu('開討論串');
  await longPress(store.getState().messages[1].id);
  await screen.findByText('以下是討論串');
  const to = jest.spyOn(ScrollView.prototype as any, 'scrollTo').mockImplementation(() => {});
  await fireEvent.press(screen.getByLabelText('關閉討論串'));
  await screen.findByText('Go 怎麼裝', {}, { timeout: 3000 });
  await act(async () => await new Promise((r) => requestAnimationFrame(r)));
  expect(to).toHaveBeenCalledWith({ y: 300, animated: false });
});

test('討論串浮在原對話上：後面墊著剛才原對話的截圖；讀螢幕只在卡片裡，兩指畫 Z 也能回去', async () => {
  const { store } = await setup();
  const capture = jest.requireMock('react-native-view-shot').captureScreen as jest.Mock;
  capture.mockClear();
  menu('開討論串');
  await longPress(store.getState().messages[1].id);
  await screen.findByText('以下是討論串');
  expect(capture).toHaveBeenCalledTimes(1);
  // 原對話的標題列不在了（在模糊的截圖裡），卡片上方是「討論串」和 ✕
  expect(screen.queryByLabelText('對話清單')).toBeNull();
  expect(screen.getByLabelText('關閉討論串')).toBeTruthy();
  // 卡片是讀螢幕的範圍：後面點不到；VoiceOver 兩指畫 Z 回到原對話
  const card = screen.getByLabelText('關閉討論串').parent;
  let modal: any = card;
  while (modal && !modal.props?.accessibilityViewIsModal) modal = modal.parent;
  expect(modal).toBeTruthy();
  await fireEvent(modal, 'accessibilityEscape');
  expect(await screen.findByText('Go 怎麼裝', {}, { timeout: 3000 })).toBeTruthy();
});

test('討論串還在回答就關掉：不停掉，入口寫「回答中…」，答完寫「新回答」，打開看過就拿掉；原對話照樣可以問', async () => {
  const { store, net } = await setup();
  menu('開討論串');
  await longPress(store.getState().messages[1].id);
  await screen.findByText('以下是討論串');
  let finish!: () => void;
  const holdLast = new Promise<void>((r) => (finish = r));
  const host = net.hosts.get(A)!;
  host.reply = (body: any) =>
    body.messages.at(-1).content === '牛肉湯哪家好'
      ? { lines: [{ message: { content: '阿村' }, done: false }, { message: { content: '牛肉湯' }, done: false }, { message: { content: '' }, done: true }], holdLast }
      : { lines: [{ message: { content: '回答：' + body.messages.at(-1).content }, done: false }, { message: { content: '' }, done: true }] };
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '牛肉湯哪家好');
  await fireEvent.press(screen.getByLabelText('送出'));
  await waitFor(() => expect(store.getState().streaming).not.toBeNull());
  await fireEvent.press(screen.getByLabelText('關閉討論串'));
  expect(await screen.findByText('討論串 · 回答中…', {}, { timeout: 3000 })).toBeTruthy();
  // 原對話照樣可以問
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '那 Python 呢');
  await fireEvent.press(screen.getByLabelText('送出'));
  expect(await screen.findByText('回答：那 Python 呢')).toBeTruthy();
  // 側邊欄：這段（它的討論串在背景回答）寫「回答中…」
  await fireEvent.press(screen.getByLabelText('對話清單'));
  expect(await screen.findByText('回答中…')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('關閉對話清單'));
  finish();
  expect(await screen.findByText('討論串（1 則）· 新回答', {}, { timeout: 3000 })).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('討論串，有新回答，點一下打開'));
  expect(await screen.findByText('阿村牛肉湯')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('關閉討論串'));
  expect(await screen.findByText('討論串（1 則）', {}, { timeout: 3000 })).toBeTruthy();
});
