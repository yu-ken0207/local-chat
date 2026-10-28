import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 看得懂：按鈕有文字、進階資訊收起來、左滑刪除、操作後有回饋

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

async function setup(questions: string[] = ['你好']) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b', vision: true, think: 'toggle' }, { name: 'llama3:latest' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  for (const q of questions) await store.send(q);
  await store.titleTask;
  const copyText = jest.fn();
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={copyText} />);
  return { net, store, copyText };
}

const pickAction = (...indexes: number[]) => {
  const queue = [...indexes];
  return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_o, cb) => cb(queue.shift() ?? 99));
};
const swipeDelete = (el: any) => fireEvent(el, 'accessibilityAction', { nativeEvent: { actionName: 'delete' } });

afterEach(() => jest.restoreAllMocks());

test('標題列的按鈕有文字：「對話」「新對話」；標題旁有 ⌄ 表示可以點', async () => {
  await setup();
  expect(screen.getByText('對話')).toBeTruthy();
  expect(screen.getByText('新對話')).toBeTruthy();
  expect(screen.getByTestId('symbol-chevron.down')).toBeTruthy();
});

test('最後一則回答下方直接有「複製」：複製後畫面顯示「已複製」', async () => {
  const { copyText } = await setup();
  await fireEvent.press(screen.getByText('複製'));
  expect(copyText).toHaveBeenCalledWith('回答：你好');
  expect(screen.getByTestId('toast')).toBeTruthy();
  expect(screen.getByText('已複製')).toBeTruthy();
});

test('最後一則回答下方直接有「重新產生」', async () => {
  const { store } = await setup();
  const old = store.getState().messages[1].id;
  await fireEvent.press(screen.getByText('重新產生'));
  await waitFor(() => expect(store.getState().messages[1]?.id).not.toBe(old));
  await waitFor(() => expect(store.getState().streaming).toBeNull());
});

test('只有最後一則回答下方有按鈕', async () => {
  await setup(['一', '二']);
  expect(screen.getAllByText('重新產生')).toHaveLength(1);
});

test('回答的「詳細資訊」：原始模型名稱、電腦、速度、時間', async () => {
  const { store } = await setup();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  pickAction(5);
  await fireEvent(screen.getByTestId(`message-${store.getState().messages[1].id}`), 'longPress');
  expect(alert.mock.calls[0][0]).toBe('詳細資訊');
  const body = alert.mock.calls[0][1] as string;
  expect(body).toContain('模型：Gemma 4 · 31B（gemma4:31b）');
  expect(body).toContain('電腦：192.168.1.20');
  expect(body).toContain('每秒約 40.0 個字詞');
  expect(body).toContain('花費時間：1s');
});

test('模型的「詳細資訊」：原始名稱、大小、能記住多少', async () => {
  await setup();
  await fireEvent.press(screen.getByLabelText(/模型：/));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  pickAction(0);
  await fireEvent.press(await screen.findByLabelText('Llama 3 的選項'));
  expect(alert.mock.calls[0][0]).toBe('詳細資訊');
  expect(alert.mock.calls[0][1]).toContain('原始名稱：llama3:latest');
  expect(alert.mock.calls[0][1]).toContain('最多能記住：131,072 tokens');
});

test('對話清單往左滑可以刪除（也支援 VoiceOver 的刪除動作）', async () => {
  const { store } = await setup();
  await store.newSession();
  await store.send('第二段');
  await store.titleTask;
  const first = (await store.listSessions()).at(-1)!;
  await fireEvent.press(screen.getByText('對話'));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
  await swipeDelete(await screen.findByTestId(`swipe-session-${first.id}`));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  await waitFor(async () => expect(await store.listSessions()).toHaveLength(1));
});

test('連接面板的電腦往左滑可以移除', async () => {
  const { store } = await setup();
  await fireEvent.press(screen.getByLabelText(/模型：/));
  await fireEvent.press(await screen.findByText('新增電腦'));
  await swipeDelete(await screen.findByTestId(`swipe-host-${A}`));
  await waitFor(() => expect(store.getState().hosts).toEqual([]));
});

test('預設範本是通用的（沒有工作專用的內容）', async () => {
  const { store } = await setup([]);
  expect(store.getState().templates.map((t) => t.title)).toEqual(['翻譯成英文', '翻譯成中文', '摘要重點', '潤飾文字', '描述照片', '照片裡的文字']);
});
