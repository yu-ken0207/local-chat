import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Share, TextInput } from 'react-native';

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
/** 讓選單自動選：給字就照字找（選單項目會增減，照位置選容易選錯），給數字照位置 */
function pickActions(...choices: (number | string)[]) {
  const queue = [...choices];
  return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => {
    const c = queue.shift();
    cb(typeof c === 'string' ? o.options.indexOf(c) : (c ?? 99));
  });
}
const msgId = (store: ChatStore, i: number) => store.getState().messages[i].id;
const longPress = (store: ChatStore, i: number) => fireEvent(screen.getByTestId(`message-${msgId(store, i)}`), 'longPress');
const inputValue = () => screen.getByLabelText('訊息輸入框').props.value;

afterEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe('長按 AI 的回答', () => {
  test('複製、分享', async () => {
    const { store, copyText } = await setup(['你好']);
    pickActions('複製');
    await longPress(store, 1);
    expect(copyText).toHaveBeenCalledWith('回答：你好');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as any);
    pickActions('分享');
    await longPress(store, 1);
    expect(share).toHaveBeenCalledWith({ message: '回答：你好' });
  });

  test('重新產生中間的回答：不用先確認，後面的訊息可以按「復原」拿回來', async () => {
    const { store } = await setup(['第一題', '第二題']);
    const old = msgId(store, 1);
    pickActions('重新產生');
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
    pickActions('重新產生');
    const alert = jest.spyOn(Alert, 'alert');
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(alert).not.toHaveBeenCalled();
    expect(store.getState().messages).toHaveLength(2);
  });

  test('換個模型重新產生：選了 llama3 之後回答標上 llama3', async () => {
    const { store } = await setup(['hi']);
    pickActions('換個模型重新產生', 1); // 第二個模型（llama3:latest）
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().messages[1]?.model).toBe('llama3:latest'));
    // 回答下方寫「模型，電腦」；輸入列下方只有一台電腦時只寫模型
    await waitFor(() => expect(screen.getByText('Llama 3，192.168.1.20')).toBeTruthy());
    expect(screen.getByText('Llama 3')).toBeTruthy();
  });

  test('刪除：不用先確認，按「復原」拿回來', async () => {
    const { store } = await setup(['hi']);
    pickActions('刪除');
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().messages).toHaveLength(1));
    await fireEvent.press(screen.getByText('復原'));
    await waitFor(() => expect(store.getState().messages).toHaveLength(2));
  });
});

describe('長按自己的訊息', () => {
  test('複製', async () => {
    const { store, copyText } = await setup(['你好']);
    pickActions('複製');
    await longPress(store, 0);
    expect(copyText).toHaveBeenCalledWith('你好');
  });

  test('編輯並重送：文字放回輸入框、提示會取代之後的訊息，送出後換掉', async () => {
    const { store } = await setup(['原本', '追問']);
    pickActions('編輯並重送');
    await longPress(store, 0);
    expect(inputValue()).toBe('原本');
    expect(screen.getByText('編輯中：送出後會取代這則訊息和之後的 3 則')).toBeTruthy();
    // 自己打字不換輸入框（換了鍵盤會收起來）：打字前後是同一個
    const typing = screen.getByLabelText('訊息輸入框');
    await fireEvent.changeText(typing, '改過');
    expect(screen.getByLabelText('訊息輸入框')).toBe(typing);
    await fireEvent.press(screen.getByLabelText('送出'));
    await waitFor(() => expect(store.getState().messages.map((m) => m.content)).toEqual(['改過', '回答：改過']));
    expect(screen.queryByText(/編輯中/)).toBeNull();
  });

  test('正在打字時編輯並重送、取消編輯：換了輸入框也把游標放回去，鍵盤不會收起來', async () => {
    const { store } = await setup(['原本']);
    const focus = (TextInput.prototype as any).focus as jest.Mock;
    focus.mockClear();
    await fireEvent(screen.getByLabelText('訊息輸入框'), 'focus');
    pickActions('編輯並重送');
    await longPress(store, 0);
    expect(inputValue()).toBe('原本');
    expect(focus).toHaveBeenCalledTimes(1);
    await fireEvent(screen.getByLabelText('訊息輸入框'), 'focus');
    await fireEvent.press(screen.getByText('取消編輯'));
    expect(focus).toHaveBeenCalledTimes(2);
  });

  test('沒在打字時編輯並重送：不自己叫出鍵盤', async () => {
    const { store } = await setup(['原本']);
    const focus = (TextInput.prototype as any).focus as jest.Mock;
    focus.mockClear();
    pickActions('編輯並重送');
    await longPress(store, 0);
    expect(inputValue()).toBe('原本');
    expect(focus).not.toHaveBeenCalled();
  });

  test('程式換掉輸入框的字（放回訊息、送出後清空）時換一個新的輸入框，高度才會照新的字量', async () => {
    // RN 0.88 多行輸入框被程式改字時量的是改之前的字：放回四行的訊息只有一行高、清空後停在四行高
    const { store } = await setup(['第一行\n第二行\n第三行\n第四行']);
    const before = screen.getByLabelText('訊息輸入框');
    pickActions('編輯並重送');
    await longPress(store, 0);
    const filled = screen.getByLabelText('訊息輸入框');
    expect(filled.props.value).toBe('第一行\n第二行\n第三行\n第四行');
    expect(filled).not.toBe(before);
    await fireEvent.press(screen.getByText('取消編輯'));
    expect(screen.getByLabelText('訊息輸入框')).not.toBe(filled);
  });

  test('取消編輯：清空輸入框，不會動到原本的訊息', async () => {
    const { store } = await setup(['原本']);
    pickActions('編輯並重送');
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
