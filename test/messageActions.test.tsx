import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Speech from 'expo-speech';
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
const confirm = () => jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
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

  test('重新產生：後面還有訊息時先確認，確認後後面的訊息都換掉', async () => {
    const { store } = await setup(['第一題', '第二題']);
    const old = msgId(store, 1);
    pickActions(2);
    const alert = confirm();
    await longPress(store, 1);
    expect(alert.mock.calls[0][1]).toBe('之後的 2 則訊息也會一起刪掉。');
    await waitFor(() => expect(store.getState().messages).toHaveLength(2));
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    expect(msgId(store, 1)).not.toBe(old);
    expect(screen.queryByText('第二題')).toBeNull();
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
    await waitFor(() => expect(screen.getAllByText('192.168.1.20 · Llama 3')).toHaveLength(2)); // 回答下方與輸入列下方
  });

  test('朗讀：念去掉符號的文字，顯示朗讀中，可以停止', async () => {
    const { store, net } = await setup();
    net.hosts.get(A)!.reply = () => ({
      lines: [
        { message: { content: '## 天氣\n\n明天**會下雨**' }, done: false },
        { message: { content: '' }, done: true },
      ],
    });
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '明天天氣');
    await fireEvent.press(screen.getByLabelText('送出'));
    await waitFor(() => expect(store.getState().messages[1]?.content).toContain('會下雨'));
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    pickActions(4);
    await longPress(store, 1);
    expect(Speech.speak).toHaveBeenCalledWith('天氣\n\n明天會下雨', expect.objectContaining({ language: 'zh-TW' }));
    expect(screen.getByText('朗讀中…')).toBeTruthy();
    await fireEvent.press(screen.getByText('停止'));
    expect(Speech.stop).toHaveBeenCalled();
    expect(screen.queryByText('朗讀中…')).toBeNull();
  });

  test('刪除', async () => {
    const { store } = await setup(['hi']);
    pickActions(6);
    confirm();
    await longPress(store, 1);
    await waitFor(() => expect(store.getState().messages).toHaveLength(1));
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

describe('提示詞範本', () => {
  test('新對話時輸入框上方有範本，點了放進輸入框；有對話之後就不顯示', async () => {
    const { store } = await setup();
    await fireEvent.press(screen.getByLabelText('範本 翻譯成英文'));
    expect(inputValue()).toBe('把下面這段翻譯成自然的英文：\n');
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), 'hello');
    await fireEvent.press(screen.getByLabelText('送出'));
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    await waitFor(() => expect(store.getState().messages).toHaveLength(2));
    expect(screen.queryByLabelText('範本 翻譯成英文')).toBeNull();
  });

  test('打 / 叫出範本，依標題篩選', async () => {
    await setup(['先聊一句']);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '/摘要');
    expect(screen.getAllByLabelText(/^範本 /).map((x) => x.props.accessibilityLabel)).toEqual(['範本 摘要重點']);
    await fireEvent.press(screen.getByLabelText('範本 摘要重點'));
    expect(inputValue()).toBe('用條列整理下面內容的重點：\n');
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '/火星');
    expect(screen.getByText('沒有符合的範本')).toBeTruthy();
  });

  test('管理範本：新增後出現在清單與輸入框上方；刪除前確認', async () => {
    const { store } = await setup();
    await fireEvent.press(screen.getByLabelText('管理範本'));
    await fireEvent.press(await screen.findByText('新增範本'));
    await fireEvent.changeText(screen.getByLabelText('範本標題'), '寫日報');
    await fireEvent.changeText(screen.getByLabelText('範本內容'), '把下面整理成日報：');
    await fireEvent.press(screen.getByText('儲存'));
    expect(await screen.findByLabelText('修改範本 寫日報')).toBeTruthy();

    confirm();
    await fireEvent.press(screen.getByLabelText('刪除範本 寫日報'));
    await waitFor(() => expect(store.getState().templates.some((t) => t.title === '寫日報')).toBe(false));
  });

  test('範本沒填完不能存', async () => {
    const { store } = await setup();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.press(screen.getByLabelText('管理範本'));
    await fireEvent.press(await screen.findByText('新增範本'));
    await fireEvent.changeText(screen.getByLabelText('範本標題'), '只有標題');
    await fireEvent.press(screen.getByText('儲存'));
    expect(alert.mock.calls[0][0]).toBe('還沒填完');
    expect(store.getState().templates.some((t) => t.title === '只有標題')).toBe(false);
  });
});
