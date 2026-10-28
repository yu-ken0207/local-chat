import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

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

async function setup(options: { model?: string | null } = {}) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: MODELS });
  const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => '192.168.1.10', throttleMs: 5 });
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
  test('沒有主機：歡迎畫面提示，點「按這裡」打開主機面板，可以手動新增', async () => {
    await setup({ model: null });
    expect(screen.getByText('選擇模型')).toBeTruthy();
    await fireEvent.press(screen.getByText('按這裡'));
    expect(screen.getByText(/還沒有主機。連 Wi-Fi/)).toBeTruthy();

    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('192.168.1.20'));
    await fireEvent.press(screen.getByText('新增'));
    expect(await screen.findByLabelText('主機 192.168.1.20，在線')).toBeTruthy();
    expect(await screen.findByLabelText(/模型 gemma4:31b，看得懂圖片，可以思考/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText(/模型 gemma4:31b/));
    expect(await screen.findByText('192.168.1.20 · gemma4:31b')).toBeTruthy();
  });

  test('新增連不到的主機：問要不要照樣加入', async () => {
    await setup({ model: null });
    await fireEvent.press(screen.getByText('按這裡'));
    jest.spyOn(Alert, 'prompt').mockImplementation((_t, _m, cb: any) => cb('192.168.1.99'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByText('新增'));
    expect(alert.mock.calls[0][0]).toBe('連不到這台主機');
    expect(await screen.findByLabelText('主機 192.168.1.99，離線')).toBeTruthy();
  });

  test('掃描區網：顯示結果', async () => {
    await setup({ model: null });
    await fireEvent.press(screen.getByText('按這裡'));
    await fireEvent.press(screen.getByText('掃描區網'));
    expect(await screen.findByText('掃描完成，找到 1 台')).toBeTruthy();
    expect(screen.getByLabelText('主機 192.168.1.20，在線')).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText('思考 關'));
    expect(screen.getByLabelText('思考 開')).toBeTruthy();
    await send(store, '問');
    expect(net.chatBodies()[0].think).toBe(true);

    await act(async () => {
      await store.selectModel(A, 'gpt-oss:20b');
    });
    pickActionSheet(2);
    await fireEvent.press(screen.getByLabelText('思考 medium'));
    expect(screen.getByLabelText('思考 high')).toBeTruthy();

    await act(async () => {
      await store.selectModel(A, 'llama3:latest');
    });
    expect(screen.queryByText(/^思考/)).toBeNull();
  });

  test('沒打字也沒照片時不能送出', async () => {
    await setup();
    expect(disabled('送出')).toBe(true);
    await type('hi');
    expect(disabled('送出')).toBe(false);
  });
});

describe('對話', () => {
  test('送出後顯示自己的話、AI 的 Markdown 回答與速度', async () => {
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
    expect(screen.getByText('192.168.1.20 · gemma4:31b · 50.0 tok/s · 2s')).toBeTruthy();
    expect(screen.getByText('對話')).toBeTruthy(); // 標題列
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

  test('上下文快滿：顯示提醒，按「開新對話」開新的一段', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.runtimeCtx = 140;
    await send(store, 'hi');
    expect(await screen.findByText(/對話快超過模型能記住的長度（120 \/ 140）/)).toBeTruthy();
    const before = store.getState().session!.id;
    await fireEvent.press(screen.getByText('開新對話'));
    await waitFor(() => expect(store.getState().session!.id).not.toBe(before));
    expect(screen.getByText('新對話')).toBeTruthy();
  });

  test('連不到主機：顯示紅色錯誤', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.online = false;
    await send(store, 'hi');
    expect(await screen.findByText(/沒有得到回答：連不到主機/)).toBeTruthy();
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
    await fireEvent.press(screen.getByLabelText(/模型：192.168.1.20 · gemma4:31b/));
    const row = await screen.findByLabelText('模型 gemma4:31b，看得懂圖片，可以思考，已載入');
    expect(within(row).getByText('看圖')).toBeTruthy();
    expect(within(row).getByText('思考')).toBeTruthy();

    pickActionSheet(0);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
    await fireEvent.press(screen.getByLabelText('gemma4:31b 的選項'));
    expect(alert.mock.calls[0][0]).toBe('卸載 gemma4:31b？');
    await waitFor(() => expect(net.hosts.get(A)!.loaded).toEqual([]));
    expect(await screen.findByLabelText('模型 gemma4:31b，看得懂圖片，可以思考')).toBeTruthy();
  });

  test('長按主機可以刪除', async () => {
    const { store } = await setup();
    await fireEvent.press(screen.getByLabelText(/模型：/));
    pickActionSheet(1);
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons: any) => buttons?.[1]?.onPress?.());
    await fireEvent(screen.getByLabelText('主機 192.168.1.20，在線'), 'longPress');
    await waitFor(() => expect(store.getState().hosts).toEqual([]));
    expect(screen.getByText(/還沒有主機。連 Wi-Fi/)).toBeTruthy();
  });
});
