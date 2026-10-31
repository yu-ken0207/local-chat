import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import { StyleSheet } from 'react-native';

import { ChatScreen } from '../src/components/ChatScreen';
import { UsageMeter, UsageSheet } from '../src/components/UsageSheet';
import { setLanguage } from '../src/i18n';
import { fmtCount, fmtRough, fmtUnload } from '../src/lib/format';
import { ChatStore, type UsageReport } from '../src/state/chatStore';
import { Repo, type UsageTotals } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

// 用量：每次叫模型記一筆；輸入框下方的儀表、用量面板（這段對話、電腦、今天與這 7 天的累計）

const A = 'http://192.168.1.20:11434';
jest.setTimeout(20_000);

async function setup() {
  const net = new FakeOllamaNet();
  // 取標題也回報用了多少（背景工作）
  const titleReply = () => ({ lines: [{ message: { content: '打招呼' }, done: false }, { message: { content: '' }, done: true, prompt_eval_count: 40, eval_count: 6 }] });
  net.addHost(A, { models: [{ name: 'gemma4:31b' }, { name: 'qwen3:8b' }], titleReply });
  const repo = new Repo(memoryDb());
  const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5, autoScan: false });
  await store.init();
  await store.addHost('192.168.1.20');
  await store.loadModels(A);
  await store.selectModel(A, 'gemma4:31b');
  return { net, repo, store };
}

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ calls: 0, promptTokens: 0, outputTokens: 0, totalMs: 0, evalMs: 0, backgroundTokens: 0, byModel: [], ...over });
const stub = (report: UsageReport) => ({ usageReport: jest.fn(async () => report), hostLabel: (u: string) => (u === A ? '書房電腦' : u) }) as unknown as ChatStore;

describe('格式', () => {
  afterEach(() => setLanguage('zh-Hant'));

  test('大數字：中文用萬、億，英文用 K、M', () => {
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(9999)).toBe('9,999');
    expect(fmtCount(15_234)).toBe('1.5 萬');
    expect(fmtCount(30_000)).toBe('3 萬');
    expect(fmtCount(1_523_000)).toBe('152 萬');
    expect(fmtCount(250_000_000)).toBe('2.5 億');
    setLanguage('en');
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(15_234)).toBe('15.2K');
    expect(fmtCount(152_300)).toBe('152K');
    expect(fmtCount(2_500_000)).toBe('2.5M');
  });

  test('估出來的數字取整，看起來不像精確值', () => {
    expect(fmtRough(22_213)).toBe('22,200');
    expect(fmtRough(456)).toBe('460');
    expect(fmtRough(42)).toBe('42');
    expect(fmtRough(-3)).toBe('0');
  });

  test('多久後卸載；一直載入的（年份很遠）不寫倒數', () => {
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(fmtUnload(at(4 * 60_000 + 10_000), now)).toBe('4 分鐘後卸載');
    expect(fmtUnload(at(30_000), now)).toBe('快要卸載了');
    expect(fmtUnload(at(2 * 3600_000), now)).toBe('2 小時後卸載');
    expect(fmtUnload('2318-01-01T00:00:00Z', now)).toBe('一直載入');
    expect(fmtUnload('', now)).toBe('');
  });
});

describe('紀錄', () => {
  test('一般聊天：回答、取標題都記下來；儀表照最後一次回答', async () => {
    const { repo, store } = await setup();
    await store.send('你好');
    const s = store.getState().session!;
    expect(await repo.lastUsage(s.id)).toMatchObject({ kind: 'answer', hostUrl: A, model: 'gemma4:31b', promptTokens: 100, outputTokens: 20 });
    expect(store.getState().context).toEqual({ used: 120, limit: 8192, level: 'ok' });
    // 取標題是背景工作：算在累計，不算這段的上下文
    await waitFor(async () => expect((await repo.usageTotals(0)).backgroundTokens).toBeGreaterThan(0));
    const all = await repo.usageTotals(0);
    expect(all.byModel).toEqual([expect.objectContaining({ hostUrl: A, model: 'gemma4:31b', calls: all.calls })]);
    expect(all.promptTokens).toBeGreaterThanOrEqual(100);
  });

  test('換到別段再回來：用量照那段最後一次回答；新開的一段先照內容估（系統說明、工具說明）', async () => {
    const { store } = await setup();
    await store.send('你好');
    const first = store.getState().session!.id;
    await store.newSession();
    await waitFor(() => expect(store.getState().context?.used).toBeGreaterThan(0));
    expect(store.getState().context!.used).not.toBe(120);
    expect((await store.usageReport()).context).toMatchObject({ estimated: true });
    await store.openSession(first);
    await waitFor(() => expect(store.getState().context).toEqual({ used: 120, limit: 8192, level: 'ok' }));
  });

  test('回答時用量一路跟著變，答完換成模型回報的實際值', async () => {
    const { net, store } = await setup();
    await store.send('你好');
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    net.hosts.get(A)!.reply = () => ({
      lines: [{ message: { content: '這是一段比較長的回答。'.repeat(30) }, done: false }, { message: { content: '' }, done: true, prompt_eval_count: 400, eval_count: 300 }],
      holdLast: hold,
    });
    const sending = store.send('再說一次');
    // 上次的 120 加上新問的、加上串流進來的三百個字
    await waitFor(() => expect(store.getState().context!.used).toBeGreaterThan(120 + 300));
    release();
    await sending;
    expect(store.getState().context).toEqual({ used: 700, limit: 8192, level: 'ok' });
  });

  test('換模型：上一個模型的實際值不能用，改照內容估', async () => {
    const { store } = await setup();
    await store.send('你好');
    await store.selectModel(A, 'qwen3:8b');
    await waitFor(() => expect(store.getState().context?.used).not.toBe(120));
    expect((await store.usageReport()).context).toMatchObject({ estimated: true });
  });

  test('用量面板的資料：各部分估算後對齊實際總數；電腦列出載入的模型', async () => {
    const { store } = await setup();
    const before = await store.usageReport();
    expect(before.context).toMatchObject({ estimated: true });
    expect(before.context!.parts.map((p) => p.key)).toContain('system');
    await store.send('幫我寫一首詩');
    const r = await store.usageReport();
    expect(r.context).toMatchObject({ estimated: false, used: 120, limit: 8192 });
    const sum = r.context!.parts.reduce((n, p) => n + p.tokens, 0);
    expect(Math.abs(sum - 120)).toBeLessThanOrEqual(r.context!.parts.length);
    expect(r.context!.parts.map((p) => p.key)).toEqual(expect.arrayContaining(['messages', 'system']));
    expect(r.computer).toMatchObject({ url: A, reachable: true, models: [expect.objectContaining({ name: 'gemma4:31b', contextLength: 8192 })] });
    expect(r.today.calls).toBeGreaterThanOrEqual(1);
    expect(r.week.calls).toBe(r.today.calls);
  });

  test('模型閒置卸載了：上限照上次回答時的，不會改用模型的最大值', async () => {
    const { net, repo, store } = await setup();
    await store.send('你好');
    const s = store.getState().session!;
    expect(await repo.lastUsage(s.id)).toMatchObject({ contextLimit: 8192 });
    net.hosts.get(A)!.loaded = [];
    expect((await store.usageReport()).context).toMatchObject({ used: 120, limit: 8192 });
    // 新開一段還沒問過：也用這個模型上次的上限
    await store.newSession();
    expect((await store.usageReport()).context).toMatchObject({ estimated: true, limit: 8192 });
  });

  test('電腦連不上：面板照樣打得開，寫連不上', async () => {
    const { net, store } = await setup();
    await store.send('你好');
    net.hosts.get(A)!.online = false;
    const r = await store.usageReport();
    expect(r.computer).toMatchObject({ reachable: false, models: [] });
    expect(r.context?.used).toBe(120);
  });
});

describe('畫面', () => {
  test('輸入框下方的儀表打開用量面板', async () => {
    const { store } = await setup();
    await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
    // 右上角，不再有「新對話」（只剩還沒取名的標題）
    expect(screen.getByTestId('usage-button')).toBeTruthy();
    expect(screen.getAllByText('新對話')).toHaveLength(1);
    await fireEvent.changeText(screen.getByLabelText('訊息輸入框'), '你好');
    await fireEvent.press(screen.getByLabelText('送出'));
    const button = await screen.findByLabelText('用量，這段用了 1%');
    // 只有小儀表和百分比；數字讀螢幕唸、點進面板看
    expect(button.props.accessibilityValue).toMatchObject({ text: '120／8,192 tokens' });
    expect(within(button).getByText('1%')).toBeTruthy();
    expect(within(button).getByTestId('usage-mini-gauge')).toBeTruthy();
    expect(within(button).queryByText(/tokens|K$/)).toBeNull();
    await fireEvent.press(button);
    const gauge = await screen.findByLabelText('AI 記住的內容');
    expect(gauge.props.accessibilityValue).toMatchObject({ min: 0, max: 100, now: 1 });
    expect(screen.getByText('120／8,192 tokens')).toBeTruthy();
    expect(screen.getByText('剩餘空間')).toBeTruthy();
    expect(screen.getByText('8,072')).toBeTruthy();
    expect(screen.getByText(/一直載入/)).toBeTruthy();
    expect(screen.getByText('總數是模型回報的，各部分是照內容估的。')).toBeTruthy();
    await fireEvent.press(screen.getByText('完成'));
    await waitFor(() => expect(screen.queryByLabelText('AI 記住的內容')).toBeNull());
  });

  test('多 AI 討論不跳「對話太長」的提示（自己會整理前情摘要），儀表照樣變色', async () => {
    const { repo, store } = await setup();
    const a = await repo.createAgent({ name: '財務長', intro: '', card: { expertise: '預算', stance: '', style: '', blindSpot: '' }, mine: true });
    await store.addMember(a.id);
    await render(<ChatScreen store={store} pickPhotos={jest.fn()} copyText={jest.fn()} />);
    // 先等打開時的估算算好，再換成快滿的
    await waitFor(() => expect(store.getState().context).not.toBeNull());
    await act(async () => (store as any).set({ context: { used: 7000, limit: 8192, level: 'near' } }));
    expect(screen.queryByText('這段對話快要太長了，AI 可能開始忘記前面的內容。')).toBeNull();
    expect(screen.getByLabelText('用量，這段用了 85%')).toBeTruthy();
  });

  test('快滿：數字和「快滿了」變色；各部分標「約」，剩餘空間是準的；累計分今天、這 7 天', async () => {
    const report: UsageReport = {
      context: {
        used: 27_000,
        limit: 32_768,
        estimated: false,
        parts: [
          { key: 'messages', tokens: 22_213 },
          { key: 'system', tokens: 2_100 },
          { key: 'tools', tokens: 2_687 },
        ],
      },
      computer: {
        url: A,
        label: '書房電腦',
        reachable: true,
        models: [{ name: 'gemma4:31b', sizeVram: 21_300_000_000, contextLength: 32_768, expiresAt: new Date(Date.now() + 4 * 60_000 + 20_000).toISOString() }],
        hardware: null,
      },
      today: totals({
        calls: 3,
        promptTokens: 52_000,
        outputTokens: 3_000,
        evalMs: 60_000,
        backgroundTokens: 5_500,
        byModel: [{ hostUrl: A, model: 'gemma4:31b', calls: 3, promptTokens: 52_000, outputTokens: 3_000, totalMs: 90_000, evalMs: 60_000 }],
      }),
      week: totals(),
    };
    await render(<UsageSheet store={stub(report)} version={0} reduceMotion onClose={jest.fn()} />);
    const gauge = await screen.findByLabelText('AI 記住的內容');
    expect(gauge.props.accessibilityValue).toMatchObject({ now: 82, text: '82%，27,000／32,768 tokens，快滿了' });
    expect(screen.getByText('82%')).toBeTruthy();
    expect(screen.getByText('快滿了')).toBeTruthy();
    expect(screen.getByText('約 22,200')).toBeTruthy();
    expect(screen.getByLabelText('對話內容：約 22,200 tokens，68%')).toBeTruthy();
    expect(screen.getByText('5,768')).toBeTruthy();
    expect(screen.getByText('顯示卡記憶體 21.3 GB，最多記住 32,768 tokens，4 分鐘後卸載')).toBeTruthy();
    expect(screen.getByText('5.2 萬')).toBeTruthy();
    expect(screen.getByText('3,000')).toBeTruthy();
    expect(screen.getByText('書房電腦，3 次，每秒 50 tokens')).toBeTruthy();
    expect(screen.getByText(/其中 10% 是背景工作/)).toBeTruthy();
    await fireEvent.press(screen.getByText('這 7 天'));
    expect(await screen.findByText('這 7 天還沒用到 AI。')).toBeTruthy();
  });

  test('滿了寫原因；不知道上限只寫數字；還沒問過全部是估的；電腦連不上、沒有載入的模型', async () => {
    const base = { today: totals(), week: totals() };
    const full: UsageReport = { ...base, context: { used: 8192, limit: 8192, estimated: false, parts: [{ key: 'messages', tokens: 8192 }] }, computer: { url: A, label: '書房電腦', reachable: false, models: [], hardware: null } };
    const { unmount } = await render(<UsageSheet store={stub(full)} version={0} reduceMotion onClose={jest.fn()} />);
    expect((await screen.findByLabelText('AI 記住的內容')).props.accessibilityValue).toMatchObject({ now: 100 });
    expect(screen.getByText('滿了，AI 已經記不住最前面的內容')).toBeTruthy();
    expect(screen.getByText('現在連不上這台電腦。')).toBeTruthy();
    expect(screen.getByText('今天還沒用到 AI。')).toBeTruthy();
    await unmount();

    const unknown: UsageReport = { ...base, context: { used: 1_913, limit: null, estimated: true, parts: [{ key: 'system', tokens: 1_913 }] }, computer: { url: A, label: '書房電腦', reachable: true, models: [], hardware: null } };
    await render(<UsageSheet store={stub(unknown)} version={0} reduceMotion onClose={jest.fn()} />);
    expect(await screen.findByText('不知道這個模型最多能記住多少')).toBeTruthy();
    expect(screen.queryByTestId('usage-gauge')).toBeNull();
    expect(screen.getAllByText('約 1,900').length).toBe(2); // 大數字和系統說明那一列
    expect(screen.queryByText('剩餘空間')).toBeNull();
    expect(screen.getByText('這段還沒問過 AI，全部是估的。')).toBeTruthy();
    expect(screen.getByText('現在沒有載入的模型，下次回答要先載入，會慢一點。')).toBeTruthy();
  });

  test('右上角小儀表：指針照實際的百分比轉（0% 左下、50% 正上、100% 右下），快滿變橘', async () => {
    const needle = () => StyleSheet.flatten(screen.getByTestId('usage-mini-needle').props.style).transform;
    const meter = (used: number) => <UsageMeter context={{ used, limit: 1000, level: used >= 1000 ? 'full' : used >= 800 ? 'near' : 'ok' }} reduceMotion onPress={jest.fn()} />;
    const { rerender } = await render(meter(0));
    expect(needle()).toEqual([{ rotate: '-45deg' }]);
    await rerender(meter(500));
    expect(needle()).toEqual([{ rotate: '90deg' }]);
    await rerender(meter(830));
    expect(needle()).toEqual([{ rotate: '179.1deg' }]);
    expect(screen.getByText('83%')).toBeTruthy();
    await rerender(meter(1000));
    expect(needle()).toEqual([{ rotate: '225deg' }]);
  });

  test('面板開著時又答完一則：重讀，指針接著轉', async () => {
    const report = (used: number): UsageReport => ({ context: { used, limit: 8192, estimated: false, parts: [{ key: 'messages', tokens: used }] }, computer: null, today: totals(), week: totals() });
    const store = stub(report(1000));
    const { rerender } = await render(<UsageSheet store={store} version={1000} reduceMotion onClose={jest.fn()} />);
    expect((await screen.findByLabelText('AI 記住的內容')).props.accessibilityValue.now).toBe(12);
    (store.usageReport as jest.Mock).mockResolvedValue(report(4096));
    await rerender(<UsageSheet store={store} version={4096} reduceMotion onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('AI 記住的內容').props.accessibilityValue.now).toBe(50));
  });
});
