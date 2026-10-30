import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Keyboard, ScrollView } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import type { NewPhoto } from '../src/lib/photos';
import { ChatStore } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet, type FakeModel } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

const A = 'http://192.168.1.20:11434';
const MODELS: FakeModel[] = [
  { name: 'gemma4:31b', vision: true, think: 'toggle' },
  { name: 'gpt-oss:20b', think: 'levels' },
  { name: 'llama3:latest' },
];
const PHOTO: NewPhoto = { base64: 'QUJD', width: 400, height: 300 };

async function setup(options: { model?: string | null; autoScan?: boolean } = {}) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: MODELS });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => '192.168.1.10', throttleMs: 5, autoScan: options.autoScan ?? false });
  await store.init();
  if (options.model !== null) {
    await store.addHost('192.168.1.20');
    await store.loadModels(A);
    await store.selectModel(A, options.model ?? 'gemma4:31b');
  }
  const pickPhotos = jest.fn(async () => [PHOTO]);
  const copyText = jest.fn();
  await render(<ChatScreen store={store} pickPhotos={pickPhotos} copyText={copyText} />);
  return { net, store, pickPhotos, copyText };
}

/** 讓 ActionSheet 自動選第 index 個選項 */
function pickActionSheet(index: number) {
  return jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_opts, cb) => cb(index));
}

const disabled = (label: string) => screen.getByLabelText(label).props.accessibilityState?.disabled;

async function type(text: string) {
  await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), text);
}

/** 打字並送出；預設等回答結束（wait='answer'），停止的測試只等開始串流 */
async function send(store: ChatStore, text: string, wait: 'answer' | 'streaming' = 'answer') {
  const before = store.getState().messages.length;
  if (text) await type(text);
  await fireEvent.press(screen.getByLabelText('送出'));
  await waitFor(() => expect(store.getState().messages.length).toBeGreaterThan(before));
  if (wait === 'answer') await waitFor(() => expect(store.getState().streaming).toBeNull());
  else await waitFor(() => expect(store.getState().streaming).not.toBeNull());
}

// 第一個測試要先載入所有模組，比較慢
jest.setTimeout(20_000);

afterEach(() => jest.restoreAllMocks());

describe('第一次使用', () => {
  test('空白畫面直接給「連接你的電腦」；手動輸入位址連上後自動選好模型，可以直接聊天', async () => {
    const { store } = await setup({ model: null });
    await fireEvent.press(screen.getByText('連接你的電腦'));
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('192.168.1.20'));
    await fireEvent.press(await screen.findByText('手動輸入位址'));
    await waitFor(() => expect(store.getState().session).toMatchObject({ hostUrl: A, model: 'gemma4:31b' }));
    expect(await screen.findByText(/已經連上/)).toBeTruthy();
    expect(screen.getByLabelText(/模型：Gemma 4 · 31B · 192.168.1.20/)).toBeTruthy();
  });

  test('自動尋找：找到電腦就連上並選好模型', async () => {
    const { store } = await setup({ model: null });
    await fireEvent.press(screen.getByText('連接你的電腦'));
    await fireEvent.press(await screen.findByText('自動尋找'));
    await waitFor(() => expect(store.getState().session?.model).toBe('gemma4:31b'));
    expect(screen.getByText(/已經連上/)).toBeTruthy();
  });

  test('手動輸入的位址連不到：展開連線說明，問要不要先加入', async () => {
    const { store } = await setup({ model: null });
    await fireEvent.press(screen.getByText('連接你的電腦'));
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('192.168.1.99'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
    await fireEvent.press(await screen.findByText('手動輸入位址'));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('連不到這個位址');
    expect(screen.getByLabelText('連線說明')).toBeTruthy();
    await waitFor(() => expect(store.getState().hosts.map((h) => h.url)).toEqual(['http://192.168.1.99:11434']));
    expect(await screen.findByLabelText('電腦 192.168.1.99')).toBeTruthy();
  });

  test('沒連 Wi-Fi：寫出原因並展開連線說明', async () => {
    const net = new FakeOllamaNet();
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, autoScan: false });
    await store.init();
    await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
    await fireEvent.press(screen.getByText('連接你的電腦'));
    await fireEvent.press(await screen.findByText('自動尋找'));
    expect(await screen.findByText(/手機目前沒有連 Wi-Fi/)).toBeTruthy();
    expect(screen.getByLabelText('連線說明')).toBeTruthy();
  });

  test('這個 Wi-Fi 裡沒有找到：說清楚並展開連線說明', async () => {
    const net = new FakeOllamaNet();
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => '192.168.5.10', autoScan: false });
    await store.init();
    await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
    await fireEvent.press(screen.getByText('連接你的電腦'));
    await fireEvent.press(await screen.findByText('自動尋找'));
    expect(await screen.findByText('這個 Wi-Fi 裡沒有找到開著小幫手或 Ollama 的電腦。')).toBeTruthy();
    expect(screen.getByLabelText('連線說明')).toBeTruthy();
  });

  test('連線說明：可以切換 Mac／Windows／Linux，指令可以複製', async () => {
    const { copyText } = await setup({ model: null });
    await fireEvent.press(screen.getByText('連接你的電腦'));
    await fireEvent.press(await screen.findByText('連不上嗎？'));
    expect(screen.getByText(/Expose Ollama to the network/, { exact: false })).toBeTruthy();
    await fireEvent.press(screen.getByRole('tab', { name: 'Windows' }));
    await fireEvent.press(screen.getByLabelText('複製指令 setx OLLAMA_HOST 0.0.0.0'));
    expect(copyText).toHaveBeenCalledWith('setx OLLAMA_HOST 0.0.0.0');
    await fireEvent.press(screen.getByLabelText('複製指令 ollama pull gemma3'));
    expect(copyText).toHaveBeenCalledWith('ollama pull gemma3');
  });

  test('已經連上電腦但還沒有模型：空白畫面給「選擇模型」，面板裡直接從手機下載', async () => {
    const net = new FakeOllamaNet();
    net.addHost(A, { models: [] });
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, autoScan: false });
    await store.init();
    await store.addHost('192.168.1.20');
    await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: '選擇模型' }));
    expect(await screen.findByText(/這台電腦還沒有模型/)).toBeTruthy();
    await fireEvent.press(screen.getByText('選一個模型下載'));
    // 直接連 Ollama 不知道配備：推薦中等大小的
    expect(await screen.findByText(/不知道這台電腦的配備/)).toBeTruthy();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByLabelText('下載 Gemma 4 · E4B'));
    expect(alert.mock.calls[0][1]).toMatch(/請讓 App 開著/);
    await fireEvent.press(await screen.findByLabelText('使用 Gemma 4 · E4B'));
    await waitFor(() => expect(store.getState().session?.model).toBe('gemma4:e4b'));
    alert.mockRestore();
  });
});

describe('輸入列', () => {
  test('模型看得懂圖：＋可以按；看不懂：＋變灰', async () => {
    const { store } = await setup();
    expect(disabled('附加照片')).toBe(false);
    await act(async () => {
      await store.selectModel(A, 'llama3:latest');
    });
    expect(disabled('附加照片（目前的模型看不懂圖片）')).toBe(true);
  });

  test('思考開關：開關型可切換；分段型用選單選等級；沒有思考能力就不顯示', async () => {
    const { store, net } = await setup();
    await fireEvent.press(screen.getByLabelText('深入思考：關'));
    expect(screen.getByLabelText('深入思考：開')).toBeTruthy();
    await send(store, '問');
    expect(net.chatBodies()[0].think).toBe(true);

    await act(async () => {
      await store.selectModel(A, 'gpt-oss:20b');
    });
    pickActionSheet(2);
    await fireEvent.press(screen.getByLabelText('深入思考：平衡'));
    expect(screen.getByLabelText('深入思考：仔細')).toBeTruthy();

    await act(async () => {
      await store.selectModel(A, 'llama3:latest');
    });
    expect(screen.queryByText(/^深入思考/)).toBeNull();
  });

  test('沒打字也沒照片時不能送出', async () => {
    await setup();
    expect(disabled('送出')).toBe(true);
    await type('hi');
    expect(disabled('送出')).toBe(false);
  });
});

describe('鍵盤與捲動', () => {
  test('點訊息、用按鈕打開對話清單，都會收鍵盤', async () => {
    const { store } = await setup();
    await send(store, 'hi');
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    await fireEvent.press(screen.getByTestId(`message-${mine.id}`));
    expect(dismiss).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText('對話清單'));
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  test('手指在拖或放手後還在滑：內容變長也不自動捲到底；停下來在最底才跟著', async () => {
    await setup();
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    // 只算「跟著最新」的捲動（有動畫）；換對話時那次無動畫的不算
    const follows = () => toEnd.mock.calls.filter((c: any[]) => c[0]?.animated).length;
    const list = screen.getByTestId('transcript');
    const at = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: 2000 }, layoutMeasurement: { width: 390, height: 600 } } });
    await fireEvent(list, 'scrollBeginDrag', at(1400));
    await fireEvent(list, 'contentSizeChange', 390, 2100);
    expect(follows()).toBe(0);
    await fireEvent(list, 'scrollEndDrag', at(1400));
    await fireEvent(list, 'momentumScrollBegin', at(1400));
    await fireEvent(list, 'contentSizeChange', 390, 2200);
    expect(follows()).toBe(0);
    // 停在最底：之後內容變長就跟著捲
    await fireEvent(list, 'momentumScrollEnd', at(1400));
    await fireEvent(list, 'contentSizeChange', 390, 2300);
    expect(follows()).toBe(1);
    // 停在上面看舊訊息：不跟
    await fireEvent(list, 'scrollBeginDrag', at(200));
    await fireEvent(list, 'scrollEndDrag', at(200));
    await fireEvent(list, 'contentSizeChange', 390, 2400);
    expect(follows()).toBe(1);
  });
});

describe('對話', () => {
  test('送出後顯示自己的話、AI 的 Markdown 回答與白話的模型名稱', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({
      lines: [
        { message: { content: '## 標題\n\n**粗體**回答' }, done: false },
        { message: { content: '' }, done: true, eval_count: 50, eval_duration: 1e9, prompt_eval_count: 10, total_duration: 2e9 },
      ],
    });
    await send(store, '你好');
    expect(await screen.findByText('你好')).toBeTruthy();
    expect(await screen.findByText('粗體')).toBeTruthy();
    // 回答下方的小字與輸入列下方的模型都顯示白話名稱；速度與時間收在「詳細資訊」
    expect(screen.getAllByText('Gemma 4 · 31B · 192.168.1.20')).toHaveLength(2);
    expect(screen.queryByText(/tok\/s/)).toBeNull();
    expect(await screen.findByText('測試對話')).toBeTruthy(); // 標題列：模型自動取的標題
  });

  test('回答中可以停止，保留已收到的字', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫長文', 'streaming');
    expect(await screen.findByText('寫到一半')).toBeTruthy();
    expect(screen.getByLabelText('停止回答')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('停止回答'));
    expect(await screen.findByText('已停止')).toBeTruthy();
    expect(screen.getByLabelText('送出')).toBeTruthy();
  });

  test('附照片：輸入列顯示縮圖、可移除；送出後對話裡是小縮圖，點了全螢幕', async () => {
    const { pickPhotos, net, store } = await setup();
    pickActionSheet(1);
    await fireEvent.press(screen.getByLabelText('附加照片'));
    expect(pickPhotos).toHaveBeenCalledWith('library', 4);
    expect(screen.getByLabelText('移除照片 1')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('移除照片 1'));
    expect(screen.queryByLabelText('移除照片 1')).toBeNull();

    await fireEvent.press(screen.getByLabelText('附加照片'));
    await send(store, '');
    expect(await screen.findByText('這張照片裡有什麼？')).toBeTruthy();
    expect(net.chatBodies()[0].messages.at(-1).images).toEqual(['QUJD']);
    await fireEvent.press(screen.getByLabelText('照片 1，點一下放大'));
    expect(screen.getByLabelText('關閉')).toBeTruthy();
  });

  test('換成看不懂圖的模型：已附的照片被拿掉並提示；送出時顯示照片不會送出的提示', async () => {
    const { store } = await setup();
    pickActionSheet(0);
    await fireEvent.press(screen.getByLabelText('附加照片'));
    await send(store, '看圖');
    pickActionSheet(0);
    await fireEvent.press(screen.getByLabelText('附加照片'));
    await act(async () => {
      await store.selectModel(A, 'llama3:latest');
    });
    expect(screen.getByText('目前的模型看不懂圖片，已移除附上的照片。')).toBeTruthy();
    await send(store, '剛剛那張呢');
    expect(await screen.findByText(/前面的 1 張照片這次不會送出/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('關閉提示'));
    expect(screen.queryByText(/前面的 1 張照片/)).toBeNull();
  });

  test('思考過程預設收起，點了展開', async () => {
    const { store, net } = await setup();
    await act(async () => {
      await store.setThink(true);
    });
    net.hosts.get(A)!.reply = () => ({
      lines: [
        { message: { content: '', thinking: '第一步先想清楚' }, done: false },
        { message: { content: '結論' }, done: false },
        { message: { content: '' }, done: true, eval_count: 1, eval_duration: 1, prompt_eval_count: 1 },
      ],
    });
    await send(store, '想一想');
    expect(await screen.findByText('結論')).toBeTruthy();
    expect(screen.queryByText('第一步先想清楚')).toBeNull();
    await fireEvent.press(screen.getByLabelText('展開思考過程'));
    expect(screen.getByText('第一步先想清楚')).toBeTruthy();
  });

  test('上下文快滿：用白話提醒，按「開新對話」開新的一段', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.runtimeCtx = 140;
    await send(store, 'hi');
    expect(await screen.findByText('這段對話快要太長了，AI 可能開始忘記前面的內容。')).toBeTruthy();
    const before = store.getState().session!.id;
    await fireEvent.press(screen.getByText('開新對話'));
    await waitFor(() => expect(store.getState().session!.id).not.toBe(before));
    expect(screen.getByTestId('chat-title').props.children).toBe('新對話');
  });

  test('連不到電腦：白話錯誤下方有重試、連線說明、詳細資訊；重試成功後錯誤消失', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.online = false;
    await send(store, 'hi');
    expect(await screen.findByText('沒有得到回答：電腦開著，但 Ollama 沒有開，或沒有開放讓區網連線。')).toBeTruthy();
    await fireEvent.press(screen.getByText('詳細資訊'));
    expect(screen.getByText(/Network request failed/)).toBeTruthy();
    await fireEvent.press(screen.getByText('連線說明'));
    expect(await screen.findByLabelText('連線說明')).toBeTruthy();
    await fireEvent.press(screen.getByText('完成'));
    net.hosts.get(A)!.online = true;
    await fireEvent.press(screen.getByText('重試'));
    await waitFor(() => expect(store.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']));
    expect(screen.queryByText(/沒有得到回答/)).toBeNull();
  });

  test('停止之後可以按「重新回答」', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '一半' }, done: false }], hang: true });
    await send(store, '寫長文', 'streaming');
    await fireEvent.press(screen.getByLabelText('停止回答'));
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    net.hosts.get(A)!.reply = undefined;
    await fireEvent.press(await screen.findByText('重新回答'));
    await waitFor(() => expect(store.getState().messages.at(-1)?.content).toBe('回答：寫長文'));
  });

  test('程式碼區塊的複製按鈕', async () => {
    const { net, store, copyText } = await setup();
    net.hosts.get(A)!.reply = () => ({
      lines: [
        { message: { content: '```sh\nls -la\n```' }, done: false },
        { message: { content: '' }, done: true, eval_count: 1, eval_duration: 1, prompt_eval_count: 1 },
      ],
    });
    await send(store, '列出檔案');
    await fireEvent.press(await screen.findByLabelText('複製程式碼'));
    expect(copyText).toHaveBeenCalledWith('ls -la');
  });
});

describe('主機與模型面板', () => {
  test('模型標示看圖、思考、已載入；卸載前先確認', async () => {
    const { net, store } = await setup();
    await send(store, '先用一次'); // 用過之後 gemma4:31b 會在已載入清單
    await fireEvent.press(screen.getByLabelText(/模型：Gemma 4 · 31B · 192.168.1.20/));
    const row = await screen.findByLabelText('模型 Gemma 4 · 31B，看得懂圖片，可以深入思考，回答較快');
    expect(within(row).getByText('看得懂圖片')).toBeTruthy();
    expect(within(row).getByText('可以深入思考')).toBeTruthy();
    expect(within(row).getByText('回答較快')).toBeTruthy();

    pickActionSheet(1); // 0 是詳細資訊、1 是卸載
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByLabelText('Gemma 4 · 31B 的選項'));
    expect(alert.mock.calls[0][0]).toBe('卸載 gemma4:31b？');
    await waitFor(() => expect(net.hosts.get(A)!.loaded).toEqual([]));
    expect(await screen.findByLabelText('模型 Gemma 4 · 31B，看得懂圖片，可以深入思考')).toBeTruthy();
  });

  test('選擇模型面板：「新增電腦」打開連接面板；長按電腦可以移除', async () => {
    const { store } = await setup();
    await fireEvent.press(screen.getByLabelText(/模型：/));
    await fireEvent.press(await screen.findByText('新增電腦'));
    pickActionSheet(0); // 只有「移除這台電腦」
    await fireEvent(await screen.findByLabelText('電腦 192.168.1.20'), 'longPress');
    await waitFor(() => expect(store.getState().hosts).toEqual([]));
  });
});

describe('送出時的輸入框', () => {
  test('按下送出就清空，不用等回答結束', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '慢慢想' }, done: false }], hang: true });
    await send(store, '嗨你好', 'streaming');
    expect(screen.getByLabelText('訊息輸入框').props.value).toBe('');
    expect(store.getState().streaming).not.toBeNull();
    store.stop();
    await waitFor(() => expect(store.getState().streaming).toBeNull());
  });

  test('訊息沒送出去：字和照片放回輸入框，並說明原因', async () => {
    const { store } = await setup();
    jest.spyOn(store, 'send').mockRejectedValue(new Error('請先選一個模型'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    pickActionSheet(1);
    await fireEvent.press(screen.getByLabelText('附加照片'));
    await type('留著我');
    await fireEvent.press(screen.getByLabelText('送出'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('沒有送出', '請先選一個模型'));
    expect(screen.getByLabelText('訊息輸入框').props.value).toBe('留著我');
    expect(screen.getByLabelText('移除照片 1')).toBeTruthy();
  });
});
