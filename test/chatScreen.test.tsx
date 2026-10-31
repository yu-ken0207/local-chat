import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { AccessibilityInfo, ActionSheetIOS, Alert, Keyboard, ScrollView } from 'react-native';

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

/** 訊息區的捲動事件：畫面 600 高、內容預設 2000 高；inset 是鍵盤開著時的底部留白 */
const scrollAt = (y: number, inset = 0, height = 2000) => ({
  nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height }, contentInset: { top: 0, left: 0, right: 0, bottom: inset }, layoutMeasurement: { width: 390, height: 600 } },
});

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
    expect(screen.getByLabelText('模型：Gemma 4 31B，點一下切換')).toBeTruthy();
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

  test('電腦連不到：空白畫面不寫「已經連上」，說連不到並給「連線說明」', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.online = false;
    await act(async () => {
      await store.refreshHosts();
    });
    expect(screen.queryByText(/已經連上/)).toBeNull();
    expect(screen.getByText(/現在連不到你的電腦/)).toBeTruthy();
    await fireEvent.press(screen.getByText('連線說明'));
    expect(await screen.findByText('連接你的電腦')).toBeTruthy();
  });

  test('已經連上電腦但上面還沒有模型：空白畫面給「下載一個模型」，面板裡直接從手機下載', async () => {
    const net = new FakeOllamaNet();
    net.addHost(A, { models: [] });
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, autoScan: false });
    await store.init();
    await store.addHost('192.168.1.20');
    await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
    expect(await screen.findByText(/上面還沒有模型/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '下載一個模型' }));
    expect(await screen.findByText(/這台電腦還沒有模型/)).toBeTruthy();
    await fireEvent.press(screen.getByText('選一個模型下載'));
    // 直接連 Ollama 不知道配備：推薦中等大小的
    expect(await screen.findByText(/不知道這台電腦的配備/)).toBeTruthy();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByLabelText('下載 Gemma 4 E4B'));
    expect(alert.mock.calls[0][1]).toMatch(/請讓 App 開著/);
    await fireEvent.press(await screen.findByLabelText('使用 Gemma 4 E4B'));
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
    // 灰的但按得到：按了說為什麼不能附照片
    await fireEvent.press(screen.getByLabelText('附加照片（目前的模型看不懂圖片）'));
    expect(screen.getByText('目前的模型看不懂圖片。換一個看得懂圖的模型，才能附照片。')).toBeTruthy();
    // 照著換成看得懂圖的模型：那句提示就收掉
    await act(async () => {
      await store.selectModel(A, 'gemma4:31b');
    });
    expect(screen.queryByText('目前的模型看不懂圖片。換一個看得懂圖的模型，才能附照片。')).toBeNull();
    expect(disabled('附加照片')).toBe(false);
  });

  test('「＋」說的原因變了就收掉：讀不到模型資訊時按了，讀到之後（看不懂圖）不再說「還沒讀到」', async () => {
    const { store, net } = await setup({ model: 'llama3:latest' });
    const host = net.hosts.get(A)!;
    net.hosts.delete(A);
    await act(async () => {
      await store.loadModels(A);
    });
    await fireEvent.press(screen.getByLabelText('附加照片（還沒讀到模型的資訊）'));
    expect(screen.getByText(/還沒讀到這個模型的資訊/)).toBeTruthy();
    net.hosts.set(A, host);
    await act(async () => {
      await store.loadModels(A);
    });
    expect(screen.getByLabelText('附加照片（目前的模型看不懂圖片）')).toBeTruthy();
    expect(screen.queryByText(/還沒讀到這個模型的資訊/)).toBeNull();
  });

  test('讀不到模型資訊時：編輯並重送照樣放回照片；送出時不說成「看不懂圖片」', async () => {
    const { store, net } = await setup();
    pickActionSheet(1);
    await fireEvent.press(screen.getByLabelText('附加照片'));
    await send(store, '看圖');
    net.hosts.delete(A);
    await act(async () => {
      await store.loadModels(A);
    });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => cb(o.options.indexOf('編輯並重送')));
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    await fireEvent(screen.getByTestId(`message-${mine.id}`), 'longPress');
    expect(await screen.findByLabelText('移除照片 1')).toBeTruthy();
    // 送得出去（連不到電腦時照常出現連線錯誤），不會被「看不懂圖片」擋下
    await expect(store.send('再看一次', [PHOTO])).resolves.toBeUndefined();
    expect(store.getState().messages.some((m) => m.content.includes('看不懂圖片'))).toBe(false);
  });

  test('編輯並重送沒送出去：字放回輸入框，「編輯中」也還在（再按送出才會取代原訊息）', async () => {
    const { store } = await setup();
    await send(store, '原本');
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((o, cb) => cb(o.options.indexOf('編輯並重送')));
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    await fireEvent(screen.getByTestId(`message-${mine.id}`), 'longPress');
    jest.spyOn(store, 'editAndResend').mockRejectedValueOnce(new Error('暫時失敗'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '改過');
    await fireEvent.press(screen.getByLabelText('送出'));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('沒有送出', '暫時失敗'));
    expect(screen.getByLabelText('訊息輸入框').props.value).toBe('改過');
    expect(screen.getByText(/編輯中/)).toBeTruthy();
  });

  test('讀不到模型資訊（電腦沒連上）：＋按了說讀不到，不說成模型看不懂圖；已附的照片不拿掉', async () => {
    const { store, net } = await setup();
    pickActionSheet(0);
    await fireEvent.press(screen.getByLabelText('附加照片'));
    expect(await screen.findByLabelText('移除照片 1')).toBeTruthy();
    net.hosts.delete(A);
    await act(async () => {
      await store.loadModels(A);
    });
    await fireEvent.press(screen.getByLabelText('附加照片（還沒讀到模型的資訊）'));
    expect(screen.getByText('還沒讀到這個模型的資訊（電腦可能沒連上），讀到了才知道能不能附照片。')).toBeTruthy();
    expect(screen.queryByText(/看不懂圖片/)).toBeNull();
    expect(screen.getByLabelText('移除照片 1')).toBeTruthy();
  });

  test('思考開關：開關型可切換；分段型用選單選等級；沒有思考能力就不顯示', async () => {
    const { store, net } = await setup();
    // 畫面上只寫「思考」，開的時候燈泡實心；讀螢幕是開關
    expect(screen.getByText('思考')).toBeTruthy();
    expect(screen.getByLabelText('深入思考').props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(screen.getByLabelText('深入思考'));
    expect(screen.getByLabelText('深入思考').props.accessibilityState).toMatchObject({ checked: true });
    await send(store, '問');
    expect(net.chatBodies()[0].think).toBe(true);

    await act(async () => {
      await store.selectModel(A, 'gpt-oss:20b');
    });
    pickActionSheet(2);
    expect(screen.getByText('思考：平衡')).toBeTruthy();
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

describe('VoiceOver', () => {
  test('訊息裡的按鈕各自摸得到；長按選單改成「更多動作」；› 這些記號不唸', async () => {
    const { store } = await setup();
    await send(store, 'hi');
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    expect(screen.getByTestId(`message-${mine.id}`).props.accessible).toBe(false);
    // 讀螢幕看不到記號（測試工具預設也略過對讀螢幕隱藏的元素）
    expect(screen.queryByText('›')).toBeNull();
    expect(screen.getByText('›', { includeHiddenElements: true }).props.accessibilityElementsHidden).toBe(true);
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    await fireEvent(screen.getByText('hi'), 'accessibilityAction', { nativeEvent: { actionName: 'more' } });
    expect(sheet).toHaveBeenCalledTimes(1);
  });
});

describe('選單', () => {
  test('回答中點標題也會出現「重新命名／刪除」選單', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫一篇長文', 'streaming');
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    await fireEvent.press(screen.getByTestId('chat-title'));
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(sheet.mock.calls[0][0].options).toContain('刪除這段對話');
    store.stop();
  });

  test('長按回答裡的程式碼：一樣出 AI 回答的選單', async () => {
    const { store, net } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '```js\nconst x = 1\n```' }, done: false }, { message: { content: '' }, done: true }] });
    await send(store, '寫一行程式');
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    await fireEvent(await screen.findByText('const x = 1'), 'longPress');
    expect(sheet.mock.calls[0][0].options).toContain('重新產生');
  });

  test('長按訊息：選單裡的「刪除」顯示成紅色（危險選項）', async () => {
    const { store } = await setup();
    await send(store, 'hi');
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    // 前面別的測試也會叫到輕震（例如下載），先清掉
    const impact = jest.requireMock('expo-haptics').impactAsync;
    impact.mockClear();
    await fireEvent(screen.getByTestId(`message-${mine.id}`), 'longPress');
    const opts = sheet.mock.calls[0][0];
    expect(opts.options[opts.destructiveButtonIndex as number]).toBe('刪除');
    // 長按開選單時輕震一下
    expect(impact).toHaveBeenCalledWith('medium');
  });

  test('「復原」提示還在時回答中長按：不排一個之後才跳的提示，改成輕震、讀螢幕播報', async () => {
    const { net, store } = await setup();
    await send(store, '第一題');
    await send(store, '第二題');
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '重寫中' }, done: false }], hang: true });
    // 重新產生前面的回答：後面的訊息先拿掉，出現「復原」提示，同時開始回答
    const first = store.getState().messages[1];
    void store.regenerate(first.id);
    await waitFor(() => expect(store.getState().streaming).not.toBeNull());
    expect(store.getState().undo).not.toBeNull();
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    await fireEvent(screen.getByTestId(`message-${mine.id}`), 'longPress');
    expect(announce).toHaveBeenCalledWith('AI 正在回答，答完再試一次。');
    await act(async () => {
      await store.dismissUndo();
    });
    expect(screen.queryByText('AI 正在回答，答完再試一次。')).toBeNull();
    store.stop();
  });

  test('AI 回答中長按訊息：不開選單、不震，說答完再試', async () => {
    const { net, store } = await setup();
    await send(store, 'hi');
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫一篇長文', 'streaming');
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    const impact = jest.requireMock('expo-haptics').impactAsync;
    impact.mockClear();
    const mine = store.getState().messages.find((m) => m.role === 'user')!;
    await fireEvent(screen.getByTestId(`message-${mine.id}`), 'longPress');
    expect(sheet).not.toHaveBeenCalled();
    expect(impact).not.toHaveBeenCalled();
    expect(await screen.findByText('AI 正在回答，答完再試一次。')).toBeTruthy();
    store.stop();
  });
});

describe('鍵盤與捲動', () => {
  test('送出後收鍵盤', async () => {
    const { store } = await setup();
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await send(store, 'hi');
    expect(dismiss).toHaveBeenCalled();
  });

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

  test('捲到上面看舊訊息：出現「捲到最新」，按了捲到底', async () => {
    const { store } = await setup();
    await send(store, 'hi');
    expect(screen.queryByLabelText('捲到最新')).toBeNull();
    const list = screen.getByTestId('transcript');
    await fireEvent(list, 'scrollBeginDrag', scrollAt(200));
    await fireEvent(list, 'scrollEndDrag', scrollAt(200));
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    await fireEvent.press(screen.getByLabelText('捲到最新'));
    expect(toEnd).toHaveBeenCalledWith({ animated: true });
    expect(screen.queryByLabelText('捲到最新')).toBeNull();
  });

  test('鍵盤開著時往上捲：扣掉鍵盤留白算，不會被拉回最底，也會出現「捲到最新」', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫一篇長文', 'streaming');
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    const follows = () => toEnd.mock.calls.filter((c: any[]) => c[0]?.animated).length;
    const list = screen.getByTestId('transcript');
    await act(async () => {});
    toEnd.mockClear();
    // 內容 2000、畫面 600、鍵盤留白 310：最底在 1710，往上捲 250 停在 1460
    await fireEvent(list, 'scrollBeginDrag', scrollAt(1460, 310));
    await fireEvent(list, 'scrollEndDrag', scrollAt(1460, 310));
    await fireEvent(list, 'contentSizeChange', 390, 2100);
    expect(follows()).toBe(0);
    expect(screen.getByLabelText('捲到最新')).toBeTruthy();
    store.stop();
  });

  test('輸入列變高（多打幾行、出現提示、附照片）：在最底時補捲，捲上去看舊訊息時不動', async () => {
    const { store } = await setup();
    await send(store, 'hi');
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    const area = screen.getByTestId('composer-area');
    const layout = (height: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } });
    await fireEvent(area, 'layout', layout(60));
    await act(async () => await new Promise((r) => requestAnimationFrame(r)));
    toEnd.mockClear();
    await fireEvent(area, 'layout', layout(81));
    await act(async () => await new Promise((r) => requestAnimationFrame(r)));
    expect(toEnd).toHaveBeenCalledWith({ animated: false });
    // 變矮不用捲；捲上去看舊訊息時變高也不動
    toEnd.mockClear();
    await fireEvent(area, 'layout', layout(60));
    const list = screen.getByTestId('transcript');
    await fireEvent(list, 'scrollBeginDrag', scrollAt(200));
    await fireEvent(list, 'scrollEndDrag', scrollAt(200));
    await fireEvent(area, 'layout', layout(81));
    await act(async () => await new Promise((r) => requestAnimationFrame(r)));
    expect(toEnd).not.toHaveBeenCalled();
  });

  test('點狀態列捲到最上面：不再跟著最新，出現「捲到最新」', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫一篇長文', 'streaming');
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    const list = screen.getByTestId('transcript');
    await act(async () => {});
    toEnd.mockClear();
    await fireEvent(list, 'scrollToTop', scrollAt(0));
    expect(screen.getByLabelText('捲到最新')).toBeTruthy();
    await fireEvent(list, 'contentSizeChange', 390, 2100);
    expect(toEnd.mock.calls.filter((c: any[]) => c[0]?.animated)).toHaveLength(0);
    store.stop();
  });

  test('程式自己跟著捲的時候不會冒出「捲到最新」', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫一篇長文', 'streaming');
    jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    const list = screen.getByTestId('transcript');
    // 內容長了一大段（2400），捲動位置還沒跟上（離最底 400）；這時程式捲動送來的事件不算使用者捲上去
    await fireEvent(list, 'contentSizeChange', 390, 2400);
    await fireEvent(list, 'scroll', scrollAt(1400, 0, 2400));
    await fireEvent(list, 'momentumScrollEnd', scrollAt(2000, 0, 2400));
    expect(screen.queryByLabelText('捲到最新')).toBeNull();
    // 對照：同樣離最底 400，換成手指拖的就會出現
    await fireEvent(list, 'scrollBeginDrag', scrollAt(1400, 0, 2400));
    await fireEvent(list, 'scrollEndDrag', scrollAt(1400, 0, 2400));
    expect(screen.getByLabelText('捲到最新')).toBeTruthy();
    store.stop();
  });

  test('回答一結束（「回答中」換成按鈕列）也跟著捲到底，下面的按鈕不會被切掉', async () => {
    const { net, store } = await setup();
    let finish!: () => void;
    const holdLast = new Promise<void>((r) => (finish = r));
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '好' }, done: false }, { message: { content: '' }, done: true, done_reason: 'stop' }], holdLast });
    await send(store, 'hi', 'streaming');
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    const follows = () => toEnd.mock.calls.filter((c: any[]) => c[0]?.animated).length;
    const list = screen.getByTestId('transcript');
    // 串流中先來一次（記下訊息數），從答完那一刻開始算
    await fireEvent(list, 'contentSizeChange', 390, 800);
    toEnd.mockClear();
    finish();
    await waitFor(() => expect(store.getState().streaming).toBeNull());
    // 訊息數沒變、也不在串流中：還是要跟
    await fireEvent(list, 'contentSizeChange', 390, 830);
    expect(follows()).toBe(1);
  });

  test('手指在拖或放手後還在滑：內容變長也不自動捲到底；停下來在最底才跟著', async () => {
    // AI 回答中（內容一直變長）才會自動跟著捲
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    await send(store, '寫一篇長文', 'streaming');
    const toEnd = jest.spyOn(ScrollView.prototype as any, 'scrollToEnd').mockImplementation(() => {});
    // 只算「跟著最新」的捲動（有動畫）；換對話時那次無動畫的不算
    const follows = () => toEnd.mock.calls.filter((c: any[]) => c[0]?.animated).length;
    const list = screen.getByTestId('transcript');
    const at = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: 2000 }, layoutMeasurement: { width: 390, height: 600 } } });
    // 送出時那次「多了新訊息就跟著捲」不算，從手指開始拖算起
    await act(async () => {});
    toEnd.mockClear();
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
    store.stop();
  });
});

describe('對話', () => {
  test('標題還在取的時候：標題列先顯示第一句話，不寫「對話」', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.titleReply = () => ({ lines: [{ message: { content: '' }, done: false }], hang: true });
    await send(store, '中午吃什麼');
    expect(screen.getByTestId('chat-title').props.children).toBe('中午吃什麼');
    // 大字時標題列最多放大 1.3 倍，不會擠爆
    expect(screen.getByTestId('chat-title').props.maxFontSizeMultiplier).toBe(1.3);
  });

  test('輸入列下方只寫模型名：兩台以上電腦也不寫電腦（點開選模型面板看得到）', async () => {
    const { store, net } = await setup();
    expect(screen.getByLabelText('模型：Gemma 4 31B，點一下切換')).toBeTruthy();
    net.addHost('http://192.168.1.21:11434', { models: MODELS });
    await act(async () => {
      await store.addHost('192.168.1.21');
    });
    await waitFor(() => expect(store.getState().hosts).toHaveLength(2));
    expect(screen.getByLabelText('模型：Gemma 4 31B，點一下切換')).toBeTruthy();
  });

  test('回答下的「模型，電腦」只在換了模型或電腦時才顯示', async () => {
    const { store } = await setup();
    await send(store, '第一題');
    await send(store, '第二題');
    // 只有第一則回答有；第二則同一個模型就不再重複（輸入列下方只有一台電腦時只寫模型）
    expect(screen.getAllByText('Gemma 4 31B，192.168.1.20')).toHaveLength(1);
  });

  test('AI 回了空白：寫「AI 沒有回答」，可以按重新產生', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '' }, done: true }] });
    await send(store, 'hi');
    expect(screen.getByText('AI 沒有回答。')).toBeTruthy();
    expect(screen.getByText('重新產生')).toBeTruthy();
    expect(screen.queryByText('複製')).toBeNull();
  });

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
    expect(screen.getByText('Gemma 4 31B，192.168.1.20')).toBeTruthy();
    expect(screen.getByText('Gemma 4 31B')).toBeTruthy();
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

  test('思考過程裡的程式碼區塊也有「複製」', async () => {
    const { store, net, copyText } = await setup();
    await act(async () => {
      await store.setThink(true);
    });
    net.hosts.get(A)!.reply = () => ({
      lines: [
        { message: { content: '', thinking: '先試試：\n\n```py\nprint(1)\n```' }, done: false },
        { message: { content: '結論' }, done: false },
        { message: { content: '' }, done: true },
      ],
    });
    await send(store, '想一想');
    await fireEvent.press(await screen.findByLabelText('展開思考過程'));
    await fireEvent.press(screen.getByLabelText('複製程式碼'));
    expect(copyText).toHaveBeenCalledWith('print(1)');
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
    await fireEvent.press(screen.getByLabelText('模型：Gemma 4 31B，點一下切換'));
    const row = await screen.findByLabelText('模型 Gemma 4 31B，看得懂圖片，可以深入思考，回答較快');
    expect(within(row).getByText('看得懂圖片')).toBeTruthy();
    expect(within(row).getByText('可以深入思考')).toBeTruthy();
    expect(within(row).getByText('回答較快')).toBeTruthy();

    pickActionSheet(1); // 0 是詳細資訊、1 是卸載
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByLabelText('Gemma 4 31B 的選項'));
    expect(alert.mock.calls[0][0]).toBe('卸載 gemma4:31b？');
    await waitFor(() => expect(net.hosts.get(A)!.loaded).toEqual([]));
    expect(await screen.findByLabelText('模型 Gemma 4 31B，看得懂圖片，可以深入思考')).toBeTruthy();
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
