import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Share } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

const A = 'http://192.168.1.20:11434';

jest.setTimeout(20_000);

async function setup(questions: string[] = []) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: [{ name: 'gemma4:31b', vision: true }, { name: 'llama3:latest' }] });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, throttleMs: 5 });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  for (const q of questions) await store.send(q);
  await store.titleTask;
  const copyText = jest.fn();
  await render(<ChatScreen store={store} pickPhotos={jest.fn(async () => [])} copyText={copyText} />);
  return { net, store, copyText };
}

/** ActionSheet 依序選這些選項 */
function pickActions(...indexes: number[]) {
  const queue = [...indexes];
  return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_o, cb) => cb(queue.shift() ?? 99));
}
const msgId = (store: ChatStore, i: number) => store.getState().messages[i].id;
const longPress = (store: ChatStore, i: number) => fireEvent(screen.getByTestId(`message-${msgId(store, i)}`), 'longPress');
const inputValue = () => screen.getByLabelText('訊息輸入框').props.value;

afterEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe('長按 AI 的回答', () => {
  test('複製、分享', async () => {
    const { store, copyText } = await setup(['你好']);
    pickActions(0);
    await longPress(store, 1);
    expect(copyText).toHaveBeenCalledWith('回答：你好');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
    pickActions(1);
    await longPress(store, 1);
    expect(share).toHaveBeenCalledWith({ message: '回答：你好' });
  });

  test('重新產生中間的回答：不用先確認，後面的訊息可以按「復原」拿回來', async () => {
    const { store } = await setup(['第一題', '第二題']);
    const old = msgId(store, 1);
    pickActions(2);
    const alert = jest.spyOn(Alert, 'alert');
    await longPress(store, 1);
    expect(alert).not.toHaveBeenCalled();
    await waitFor(() => expect(store.getState().messages).toHaveLength(2));
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(msgId(store, 1)).not.toBe(old);
    expect(screen.queryByText('第二題')).toBeNull();
    expect(screen.getByText('已刪掉後面的 2 則訊息')).toBeTruthy();
    await fireEvent.press(screen.getByText('復原'));
    await waitFor(() => expect(screen.getByText('第二題')).toBeTruthy());
    expect(msgId(store, 1)).toBe(old);
  });

  test('重新產生最後一則回答：舊回答留著，用 ‹ › 切換', async () => {
    const { store, net } = await setup();
    let n = 0;
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: `版本${++n}` }, done: false }, { message: { content: '' }, done: true }] });
    await store.send('問');
    await fireEvent.press(screen.getByText('重新產生'));
    await waitFor(() => expect(store.getState().messages[1]?.content).toBe('版本2'));
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(screen.getByLabelText('第 2 個回答，共 2 個')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('上一個回答'));
    expect(await screen.findByText('版本1')).toBeTruthy();
    expect(screen.getByLabelText('第 1 個回答，共 2 個')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('下一個回答'));
    expect(await screen.findByText('版本2')).toBeTruthy();
  });

  test('最後一則回答重新產生不用確認', async () => {
    const { store } = await setup(['只有一題']);
    pickActions(2);
    const alert = jest.spyOn(Alert, 'alert');
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(alert).not.toHaveBeenCalled();
    expect(store.getState().messages).toHaveLength(2);
  });

  test('換個模型重新產生：選了 llama3 之後回答標上 llama3', async () => {
    const { store } = await setup(['hi']);
    pickActions(3, 1); // 換個模型重新產生 → 第二個模型（llama3:latest）
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().messages[1]?.model).toBe('llama3:latest'));
    // 回答下方寫「模型 · 電腦」；輸入列下方只有一台電腦時只寫模型
    await waitFor(() => expect(screen.getByText('Llama 3 · 192.168.1.20')).toBeTruthy());
    expect(screen.getByText('Llama 3')).toBeTruthy();
  });

  test('刪除：不用先確認，按「復原」拿回來', async () => {
    const { store } = await setup(['hi']);
    pickActions(5);
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().messages).toHaveLength(1));
    await fireEvent.press(screen.getByText('復原'));
    await waitFor(() => expect(store.getState().messages).toHaveLength(2));
  });
});

describe('長按自己的訊息', () => {
  test('複製', async () => {
    const { store, copyText } = await setup(['你好']);
    pickActions(0);
    await longPress(store, 0);
    expect(copyText).toHaveBeenCalledWith('你好');
  });

  test('編輯並重送：文字放回輸入框、提示會取代之後的訊息，送出後換掉', async () => {
    const { store } = await setup(['原本', '追問']);
    pickActions(1);
    await longPress(store, 0);
    expect(inputValue()).toBe('原本');
    expect(screen.getByText('編輯中：送出後會取代這則訊息和之後的 3 則')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '改過');
    await fireEvent.press(screen.getByLabelText('送出'));
    await waitFor(() => expect(store.getState().messages.map((m) => m.content)).toEqual(['改過', '回答：改過']));
    expect(screen.queryByText(/編輯中/)).toBeNull();
  });

  test('取消編輯：清空輸入框，不會動到原本的訊息', async () => {
    const { store } = await setup(['原本']);
    pickActions(1);
    await longPress(store, 0);
    await fireEvent.press(screen.getByText('取消編輯'));
    expect(inputValue()).toBe('');
    expect(screen.queryByText(/編輯中/)).toBeNull();
    expect(store.getState().messages).toHaveLength(2);
  });
});

test('沒有範本按鈕；打 / 也不會跳出範本', async () => {
  await setup();
  expect(screen.queryByLabelText(/^範本 /)).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '/摘要');
  expect(screen.queryByLabelText(/^範本 /)).toBeNull();
});
