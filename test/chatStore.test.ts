/**
 * @jest-environment node
 */
import { REPLY_PROMPTS } from '../src/lib/history';
import { ChatStore, HostOfflineError, type ChatEvent } from '../src/state/chatStore';
import { Repo } from '../src/store/repo';
import { FakeOllamaNet } from './helpers/fakeOllama';
import { memoryDb } from './helpers/nodeDb';

const A = 'http://192.168.1.20:11434';
const B = 'http://192.168.1.30:11434';

const MODELS = [
  { name: 'gemma4:31b', vision: true, think: 'toggle' as const },
  { name: 'gpt-oss:20b', think: 'levels' as const },
  { name: 'llama3:latest' },
];

async function setup(options: { wifi?: string | null; autoScan?: boolean } = {}) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: MODELS });
  const repo = new Repo(memoryDb());
  const events: ChatEvent[] = [];
  const store = new ChatStore({
    repo,
    client: net.client,
    wifiIp: async () => (options.wifi === undefined ? '192.168.1.10' : options.wifi),
    throttleMs: 5,
    autoScan: options.autoScan ?? false,
    onEvent: (e) => events.push(e),
  });
  await store.init();
  return { net, repo, store, events };
}

/** 加主機、載入模型、選模型 */
async function ready(model = 'gemma4:31b') {
  const ctx = await setup();
  await ctx.store.addHost('192.168.1.20');
  await ctx.store.loadModels(A);
  await ctx.store.selectModel(A, model);
  return ctx;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('啟動與主機', () => {
  test('第一次開啟：建立一段空白對話，沒有主機', async () => {
    const { store } = await setup();
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.session).not.toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.hosts).toEqual([]);
  });

  test('手動新增：連得到就加入並顯示在線；連不到丟 HostOfflineError，force 可以照樣加入', async () => {
    const { store } = await setup();
    const h = await store.addHost('192.168.1.20', { label: '客廳電腦' });
    expect(h).toMatchObject({ url: A, label: '客廳電腦', source: 'manual', version: '0.40.0' });
    expect(store.getState().hostStatus[A].state).toBe('online');

    await expect(store.addHost('192.168.1.99')).rejects.toBeInstanceOf(HostOfflineError);
    expect(store.getState().hosts).toHaveLength(1);
    await store.addHost('192.168.1.99', { force: true });
    expect(store.getState().hosts.map((x) => x.url)).toEqual([A, 'http://192.168.1.99:11434']);
    expect(store.getState().hostStatus['http://192.168.1.99:11434'].state).toBe('offline');
  });

  test('位址格式錯誤', async () => {
    const { store } = await setup();
    await expect(store.addHost('300.1.1.1')).rejects.toThrow('IP 位址格式不對');
  });

  test('掃描區網：找到的主機記起來、回報進度', async () => {
    const { net, store } = await setup();
    net.addHost(B, { version: '0.31.1' });
    const found = await store.scanLan();
    expect(found).toBe(2);
    const s = store.getState();
    expect(s.hosts.map((h) => [h.url, h.source, h.label])).toEqual([
      [A, 'scan', '192.168.1.20'],
      [B, 'scan', '192.168.1.30'],
    ]);
    expect(s.scan).toMatchObject({ running: false, done: 253, total: 253, found: 2 });
    expect(s.hostStatus[B]).toMatchObject({ state: 'online', version: '0.31.1' });
  });

  test('第一次開 App 不會自己掃描（要等使用者按，iPhone 才在有前後文時問權限）', async () => {
    const { net, store } = await setup({ autoScan: true });
    await store.startupTask;
    expect(net.calls).toHaveLength(0);
    expect(store.getState().hosts).toEqual([]);
  });

  test('使用者按過自動尋找之後，下次開 App 沒有在線的電腦就自動找', async () => {
    const first = await setup({ autoScan: true });
    await first.store.scanLan({ userInitiated: true });
    await first.repo.removeHost(A);
    const again = new ChatStore({ repo: first.repo, client: first.net.client, wifiIp: async () => '192.168.1.10', throttleMs: 5 });
    await again.init();
    await again.startupTask;
    expect(again.getState().hosts.map((h) => h.url)).toEqual([A]);
  });

  test('已經有在線的電腦就不自動找', async () => {
    const first = await setup({ autoScan: true });
    await first.store.scanLan({ userInitiated: true });
    const calls = first.net.calls.length;
    const again = new ChatStore({ repo: first.repo, client: first.net.client, wifiIp: async () => '192.168.1.10', throttleMs: 5 });
    await again.init();
    await again.startupTask;
    expect(first.net.calls.length - calls).toBeLessThan(10); // 只問了在線狀態與模型，沒有掃 253 個位址
  });

  test('沒連 Wi-Fi 不掃描，給提示', async () => {
    const { net, store } = await setup({ wifi: null });
    expect(await store.scanLan()).toBe(0);
    expect(store.getState().scan?.error).toContain('沒有連 Wi-Fi');
    expect(net.calls).toHaveLength(0);
  });

  test('重新檢查在線狀態：關機的主機變離線', async () => {
    const { net, store } = await setup();
    await store.addHost('192.168.1.20');
    net.hosts.get(A)!.online = false;
    await store.refreshHosts();
    expect(store.getState().hostStatus[A].state).toBe('offline');
    net.hosts.get(A)!.online = true;
    await store.refreshHosts();
    expect(store.getState().hostStatus[A]).toMatchObject({ state: 'online', version: '0.40.0' });
  });

  test('刪除主機', async () => {
    const { store } = await setup();
    await store.addHost('192.168.1.20', { label: '書房' });
    expect(store.hostLabel(A)).toBe('書房');
    await store.removeHost(A);
    expect(store.getState().hosts).toEqual([]);
  });
});

describe('模型', () => {
  test('列出模型；選開關型思考的模型預設關、分段型用預設等級、沒思考能力是 null', async () => {
    const { store, repo } = await ready('gemma4:31b');
    expect(store.getState().models[A].list.map((m) => m.name)).toEqual(['gemma4:31b', 'gpt-oss:20b', 'llama3:latest']);
    expect(store.getState().session?.think).toBe(false);
    await store.selectModel(A, 'gpt-oss:20b');
    expect(store.getState().session?.think).toBe('medium');
    await store.selectModel(A, 'llama3:latest');
    expect(store.getState().session?.think).toBeNull();
    const saved = await repo.getSession(store.getState().session!.id);
    expect(saved).toMatchObject({ hostUrl: A, model: 'llama3:latest', think: null });
  });

  test('預熱、卸載會更新已載入清單', async () => {
    const { store } = await ready();
    await store.preload(A, 'gpt-oss:20b');
    expect(store.getState().loaded[A].map((m) => m.name)).toEqual(['gpt-oss:20b']);
    await store.unload(A, 'gpt-oss:20b');
    expect(store.getState().loaded[A]).toEqual([]);
  });

  test('主機連不到時模型清單顯示錯誤', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.online = false;
    await store.loadModels(A);
    expect(store.getState().models[A].error).toBe('連不到你的電腦。');
  });
});

describe('傳送與串流', () => {
  test('送出後串流回答，存下內容、統計；上下文用量看已載入模型的實際上限', async () => {
    const { store, events } = await ready();
    await store.send('今天天氣如何');
    const s = store.getState();
    expect(s.streaming).toBeNull();
    expect(s.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '今天天氣如何'],
      ['assistant', '回答：今天天氣如何'],
    ]);
    expect(s.messages[1]).toMatchObject({ model: 'gemma4:31b', hostLabel: '192.168.1.20', thinking: '' });
    expect(s.messages[1].stats).toMatchObject({ evalCount: 20, promptEvalCount: 100 });
    expect(s.context).toEqual({ used: 120, limit: 8192, level: 'ok' });
    expect(events).toEqual(['answered']);
  });

  test('開思考：送出 think=true，存下思考過程；思考與回答階段依序出現', async () => {
    const { net, store } = await ready();
    await store.setThink(true);
    const phases: string[] = [];
    store.subscribe(() => {
      const p = store.getState().streaming?.phase;
      if (p && phases.at(-1) !== p) phases.push(p);
    });
    net.hosts.get(A)!.reply = () => ({
      lines: [
        { message: { content: '', thinking: '先想' }, done: false },
        { message: { content: '答案' }, done: false },
        { message: { content: '' }, done: true, eval_count: 1, eval_duration: 1, prompt_eval_count: 1 },
      ],
    });
    // 讓每段之間有時間更新畫面
    const realFetch = net.fetch;
    net.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      const reader = res.body?.getReader();
      if (!reader) return res;
      return { ...res, body: { getReader: () => ({ read: async () => (await flush(), reader.read()) }) } };
    };
    await store.send('問題');
    expect(net.chatBodies()[0].think).toBe(true);
    expect(store.getState().messages[1]).toMatchObject({ content: '答案', thinking: '先想' });
    expect(phases).toEqual(['waiting', 'thinking', 'answering']);
  });

  test('沒有思考能力的模型不送 think；分段型送等級', async () => {
    const { net, store } = await ready('llama3:latest');
    await store.send('a');
    expect(net.chatBodies()[0]).not.toHaveProperty('think');
    await store.selectModel(A, 'gpt-oss:20b');
    await store.setThink('high');
    await store.send('b');
    expect(net.chatBodies()[1].think).toBe('high');
  });

  test('只附照片沒打字：用預設問題；照片送出', async () => {
    const { net, store } = await ready();
    await store.send('', [{ base64: 'IMG', width: 10, height: 10 }]);
    const user = store.getState().messages[0];
    expect(user.content).toBe('這張照片裡有什麼？');
    expect(user.attachments.map((a) => a.base64)).toEqual(['IMG']);
    expect(net.chatBodies()[0].messages.at(-1).images).toEqual(['IMG']);
  });

  test('看不懂圖的模型不能附照片', async () => {
    const { store } = await ready('llama3:latest');
    expect(store.canAttachImages()).toBe(false);
    await expect(store.send('看圖', [{ base64: 'IMG', width: 1, height: 1 }])).rejects.toThrow('看不懂圖片');
    expect(store.getState().messages).toEqual([]);
  });

  test('中途換成看不懂圖的模型：提示照片不會送出，請求裡沒有照片', async () => {
    const { net, store } = await ready();
    await store.send('這是什麼', [
      { base64: 'IMG1', width: 1, height: 1 },
      { base64: 'IMG2', width: 1, height: 1 },
    ]);
    await store.selectModel(A, 'llama3:latest');
    await store.send('剛剛那張是什麼顏色');
    expect(store.getState().notice).toContain('前面的 2 張照片這次不會送出');
    expect(net.chatBodies()[1].messages.some((m: any) => m.images)).toBe(false);
  });

  test('中途停止：保留已收到的字，加一則「已停止」', async () => {
    const { net, store, events } = await ready();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    const p = store.send('寫一篇長文');
    await flush();
    expect(store.getState().streaming?.content).toBe('寫到一半');
    store.stop();
    await p;
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '寫一篇長文'],
      ['assistant', '寫到一半'],
      ['note', '已停止'],
    ]);
    expect(events).toEqual(['stopped']);
  });

  test('回答中在對話清單點目前這段：不會把回答停掉', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    const p = store.send('寫一篇長文');
    await flush();
    await store.openSession(store.getState().session!.id);
    await flush();
    expect(store.getState().streaming?.content).toBe('寫到一半');
    expect(store.getState().messages.some((m) => m.role === 'note')).toBe(false);
    store.stop();
    await p;
  });

  test('回答中換到別段對話：畫面只顯示那段，收到一半的字留在原本那段', async () => {
    const { net, store, repo } = await ready();
    await store.send('第一段');
    const first = store.getState().session!.id;
    await store.newSession();
    const second = store.getState().session!.id;
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    const p = store.send('第二段');
    await flush();
    await store.openSession(first);
    await p;
    const st = store.getState();
    expect(st.session?.id).toBe(first);
    expect(st.streaming).toBeNull();
    expect(st.messages.map((m) => m.content)).not.toContain('第二段');
    expect((await repo.listMessages(second)).map((m) => [m.role, m.content])).toEqual([
      ['user', '第二段'],
      ['assistant', '寫到一半'],
      ['note', '已停止'],
    ]);
  });

  test('連不到電腦：不留空白回答，加一則白話錯誤，技術細節另外存', async () => {
    const { net, store, events } = await ready();
    net.hosts.get(A)!.online = false;
    await store.send('hi');
    expect(store.getState().messages.map((m) => m.role)).toEqual(['user', 'error']);
    expect(store.getState().messages[1]).toMatchObject({ content: '沒有得到回答：電腦開著，但 Ollama 沒有開，或沒有開放讓區網連線。', detail: expect.stringContaining('Network request failed') });
    expect(events).toEqual(['failed']);
  });

  test('模型回報錯誤', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.reply = () => ({ lines: [{ error: 'model requires more system memory' }] });
    await store.send('hi');
    expect(store.getState().messages[1]).toMatchObject({ role: 'error', content: '沒有得到回答：電腦回報錯誤：model requires more system memory' });
  });

  test('還沒選模型不能送', async () => {
    const { store } = await setup();
    await expect(store.send('hi')).rejects.toThrow('請先選一個模型');
  });

  test('上下文快滿時提醒', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.runtimeCtx = 140;
    await store.send('hi');
    expect(store.getState().context).toEqual({ used: 120, limit: 140, level: 'near' });
  });

  test('串流更新會合併，不會每個字都重畫', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.reply = () => ({
      lines: [
        ...Array.from({ length: 200 }, () => ({ message: { content: '字' }, done: false })),
        { message: { content: '' }, done: true, eval_count: 200, eval_duration: 1, prompt_eval_count: 1 },
      ],
    });
    let updates = 0;
    store.subscribe(() => updates++);
    await store.send('多寫一點');
    expect(store.getState().messages[1].content).toBe('字'.repeat(200));
    expect(updates).toBeLessThan(50);
  });
});

describe('對話', () => {
  test('新對話：目前還沒講話就不另開；有講話才開，沿用模型', async () => {
    const { store } = await ready();
    const first = store.getState().session!.id;
    await store.newSession();
    expect(store.getState().session!.id).toBe(first);
    await store.send('hi');
    await store.newSession();
    const s = store.getState();
    expect(s.session!.id).not.toBe(first);
    expect(s.session).toMatchObject({ hostUrl: A, model: 'gemma4:31b', think: false });
    expect(s.messages).toEqual([]);
  });

  test('切換對話、刪掉目前這段會切到最近的一段', async () => {
    const { store } = await ready();
    await store.send('第一段');
    const first = store.getState().session!.id;
    await store.newSession();
    await store.send('第二段');
    const second = store.getState().session!.id;
    await store.openSession(first);
    expect(store.getState().messages[0].content).toBe('第一段');
    await store.deleteSession(first);
    expect(store.getState().session!.id).toBe(second);
    await store.deleteSession(second);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().session).toMatchObject({ hostUrl: A, model: 'gemma4:31b' });
  });

  test('舊版留下的自訂指示不再送出，只送回答語言', async () => {
    const { net, store, repo } = await ready();
    await repo.updateSession(store.getState().session!.id, { systemPrompt: '你是巡檢專家' });
    await store.send('hi');
    expect(net.chatBodies()[0].messages[0]).toEqual({ role: 'system', content: REPLY_PROMPTS['zh-Hant'] });
  });

  test('重新開 App：回到最近的對話，記得模型', async () => {
    const { net, repo, store } = await ready();
    await store.send('記得我');
    const again = new ChatStore({ repo, client: net.client, wifiIp: async () => null, throttleMs: 5 });
    await again.init();
    expect(again.getState().messages[0].content).toBe('記得我');
    expect(again.getState().session).toMatchObject({ hostUrl: A, model: 'gemma4:31b' });
  });
});

describe('標題與匯出', () => {
  test('第一個回答後請模型取標題（關思考、不送照片），之後不再取', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.titleReply = () => ({ lines: [{ message: { content: '「午餐推薦」' }, done: false }, { message: { content: '' }, done: true }] });
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '吃牛肉麵' }, done: false }, { message: { content: '' }, done: true }] });
    await store.send('中午吃什麼', [{ base64: 'IMG', width: 1, height: 1 }]);
    await store.titleTask;
    expect(store.getState().session?.title).toBe('午餐推薦');
    const titleReq = net.titleBodies()[0];
    expect(titleReq.think).toBe(false);
    expect(titleReq.messages[1].content).toBe('使用者：中午吃什麼\nAI：吃牛肉麵');
    expect(JSON.stringify(titleReq)).not.toContain('IMG');
    await store.send('那晚餐呢');
    expect(net.titleBodies()).toHaveLength(1);
  });

  test('第一個回答被停掉：下一個回答出來時再取標題', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '寫到一半' }, done: false }], hang: true });
    const p = store.send('寫一篇長文');
    await flush();
    store.stop();
    await p;
    expect(net.titleBodies()).toHaveLength(0);
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '好的' }, done: false }, { message: { content: '' }, done: true }] });
    await store.send('那短一點');
    await store.titleTask;
    expect(net.titleBodies()).toHaveLength(1);
    expect(store.getState().session?.title).toBe('測試對話');
  });

  test('模型取不到標題：用第一句話', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.titleReply = () => ({ lines: [{ error: 'busy' }] });
    await store.send('幫我寫一封請假信給主管');
    await store.titleTask;
    expect(store.getState().session?.title).toBe('幫我寫一封請假信給主管');
  });

  test('使用者已經自己取了標題就不蓋掉', async () => {
    const { store } = await ready();
    await store.renameSession(store.getState().session!.id, '我的標題');
    await store.send('hi');
    expect(store.titleTask).toBeNull();
    expect(store.getState().session?.title).toBe('我的標題');
  });
});

describe('訊息操作', () => {
  test('重新產生：刪掉這則回答與之後的訊息，再問一次', async () => {
    const { net, store } = await ready();
    await store.send('第一題');
    await store.send('第二題');
    const firstAnswer = store.getState().messages[1];
    expect(store.laterCount(firstAnswer.id)).toBe(2);
    await store.regenerate(firstAnswer.id);
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '第一題'],
      ['assistant', '回答：第一題'],
    ]);
    expect(store.getState().messages[1].id).not.toBe(firstAnswer.id);
    expect(net.chatBodies().at(-1).messages.map((m: any) => m.content)).toEqual(['請用繁體中文（台灣用語）回答。', '第一題']);
  });

  test('換個模型重新產生：回答標上新模型，之後也用新模型', async () => {
    const { net, store } = await ready();
    await store.send('hi');
    await store.regenerate(store.getState().messages[1].id, { hostUrl: A, model: 'llama3:latest' });
    expect(store.getState().messages[1].model).toBe('llama3:latest');
    expect(store.getState().session?.model).toBe('llama3:latest');
    expect(net.chatBodies().at(-1).model).toBe('llama3:latest');
  });

  test('編輯並重送：這則和之後都換掉，照片可以重新附', async () => {
    const { net, store } = await ready();
    await store.send('原本的問題', [{ base64: 'OLD', width: 1, height: 1 }]);
    await store.send('追問');
    const first = store.getState().messages[0];
    await store.editAndResend(first.id, '改過的問題', [{ base64: 'NEW', width: 1, height: 1 }]);
    const msgs = store.getState().messages;
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', '改過的問題'],
      ['assistant', '回答：改過的問題'],
    ]);
    expect(msgs[0].attachments.map((a) => a.base64)).toEqual(['NEW']);
    expect(net.chatBodies().at(-1).messages.at(-1).images).toEqual(['NEW']);
  });

  test('刪除單則訊息', async () => {
    const { store } = await ready();
    await store.send('a');
    await store.deleteMessage(store.getState().messages[1].id);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['a']);
  });
});

describe('連上電腦就能用', () => {
  test('手動輸入位址連上後，自動選好模型（優先看得懂圖片的）', async () => {
    const { store } = await setup();
    await store.addHost('192.168.1.20');
    expect(store.getState().session).toMatchObject({ hostUrl: A, model: 'gemma4:31b' });
  });

  test('自動選模型：已經載入顯示卡的優先（回答最快）', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.loaded = ['llama3:latest'];
    await store.addHost('192.168.1.20');
    expect(store.getState().session?.model).toBe('llama3:latest');
  });

  test('自動尋找找到電腦後，也自動選好模型', async () => {
    const { store } = await setup();
    await store.scanLan({ userInitiated: true });
    expect(store.getState().session).toMatchObject({ hostUrl: A, model: 'gemma4:31b' });
  });

  test('已經選好的模型不會被換掉', async () => {
    const { store } = await ready('llama3:latest');
    await store.addHost('192.168.1.20');
    expect(store.getState().session?.model).toBe('llama3:latest');
  });

  test('改用另一台電腦：目前的模型那台沒有就自動換', async () => {
    const { net, store } = await ready('llama3:latest');
    net.addHost(B, { models: [{ name: 'qwen3-vl:4b', vision: true }] });
    await store.addHost('192.168.1.30');
    expect(await store.connectHost(B)).toBe('qwen3-vl:4b');
    expect(store.getState().session).toMatchObject({ hostUrl: B, model: 'qwen3-vl:4b' });
  });

  test('電腦上沒有任何模型：不選', async () => {
    const { net, store } = await setup();
    net.hosts.get(A)!.models = [];
    await store.addHost('192.168.1.20');
    expect(store.getState().session?.model).toBeNull();
  });
});

describe('重試', () => {
  test('最後一則是錯誤：拿掉錯誤再問一次', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.online = false;
    await store.send('hi');
    expect(store.getState().messages.at(-1)?.role).toBe('error');
    net.hosts.get(A)!.online = true;
    await store.retry();
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', '回答：hi'],
    ]);
  });

  test('停止後重新回答：連半截回答一起換掉', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: '一半' }, done: false }], hang: true });
    const p = store.send('寫長文');
    await flush();
    store.stop();
    await p;
    net.hosts.get(A)!.reply = undefined;
    await store.retry();
    expect(store.getState().messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '寫長文'],
      ['assistant', '回答：寫長文'],
    ]);
  });

  test('最後一則不是錯誤或停止：不動', async () => {
    const { store } = await ready();
    await store.send('hi');
    const before = store.getState().messages.map((m) => m.id);
    await store.retry();
    expect(store.getState().messages.map((m) => m.id)).toEqual(before);
  });
});

describe('掃描的回饋', () => {
  test('按下後立刻顯示檢查中；取不到網路狀態時寫出原因', async () => {
    const net = new FakeOllamaNet();
    let fail!: (e: Error) => void;
    const store = new ChatStore({
      repo: new Repo(memoryDb()),
      client: net.client,
      wifiIp: () => new Promise((_, reject) => (fail = reject)),
      autoScan: false,
    });
    await store.init();
    const p = store.scanLan();
    expect(store.getState().scan).toMatchObject({ running: true, total: 0 });
    fail(new Error('no permission'));
    expect(await p).toBe(0);
    expect(store.getState().scan).toMatchObject({ running: false, error: '沒辦法確認手機的網路（no permission）。請改用「手動輸入位址」。' });
  });

  test('用 4G 時說明要手動新增', async () => {
    const { store } = await setup({ wifi: null });
    await store.scanLan();
    expect(store.getState().scan?.error).toContain('請連上跟電腦同一個 Wi-Fi');
  });
});

describe('移除資料', () => {
  test('刪除所有對話：換成新的空白對話，模型與主機保留', async () => {
    const { store } = await ready();
    await store.send('a');
    await store.newSession();
    await store.send('b');
    await store.deleteAllSessions();
    expect((await store.listSessions()).length).toBe(1);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().session).toMatchObject({ hostUrl: A, model: 'gemma4:31b' });
    expect(store.getState().hosts).toHaveLength(1);
    expect((await store.dataInfo()).sessions).toBe(1);
  });

  test('清除全部資料：主機、模型清單都清掉，回到第一次打開的樣子', async () => {
    const { store } = await ready();
    await store.send('a');
    await store.resetAll();
    const s = store.getState();
    expect(s.hosts).toEqual([]);
    expect(s.models).toEqual({});
    expect(s.messages).toEqual([]);
    expect(s.session).toMatchObject({ hostUrl: null, model: null });
  });
});

describe('不怕按錯：復原、最近刪除、回答版本', () => {
  test('刪除訊息後可以復原', async () => {
    const { store } = await ready();
    await store.send('a');
    await store.deleteMessage(store.getState().messages[1].id);
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().undo?.message).toBe('已刪除訊息');
    await store.undoLast();
    expect(store.getState().messages.map((m) => m.content)).toEqual(['a', '回答：a']);
    expect(store.getState().undo).toBeNull();
  });

  test('刪除對話：放進最近刪除，可以馬上復原，也可以之後從最近刪除救回', async () => {
    const { store } = await ready();
    await store.send('第一段');
    const first = store.getState().session!.id;
    await store.newSession();
    await store.send('第二段');
    await store.deleteSession(first);
    expect((await store.listSessions()).map((s) => s.id)).not.toContain(first);
    expect((await store.listTrash()).map((s) => s.id)).toEqual([first]);
    await store.undoLast();
    expect(store.getState().session?.id).toBe(first);
    expect(await store.listTrash()).toEqual([]);

    await store.deleteSession(first);
    await store.dismissUndo();
    await store.restoreSession(first);
    expect((await store.listSessions()).map((s) => s.id)).toContain(first);
  });

  test('最近刪除：永久刪除單一段、清空全部', async () => {
    const { store } = await ready();
    await store.send('a');
    const a = store.getState().session!.id;
    await store.newSession();
    await store.send('b');
    const b = store.getState().session!.id;
    await store.deleteSession(a);
    await store.deleteSession(b);
    await store.deleteForever(a);
    expect((await store.listTrash()).map((s) => s.id)).toEqual([b]);
    await store.emptyTrash();
    expect(await store.listTrash()).toEqual([]);
  });

  test('最近刪除超過 30 天的，開 App 時真的刪掉', async () => {
    let now = 1_000_000_000_000;
    const net = new FakeOllamaNet();
    const repo = new Repo(memoryDb(), () => now);
    const store = new ChatStore({ repo, client: net.client, wifiIp: async () => null, autoScan: false, now: () => now });
    await store.init();
    const s = await repo.createSession();
    await repo.addMessage(s.id, { role: 'user', content: 'old' });
    await repo.trashSessions([s.id]);
    now += 29 * 86_400_000;
    await new ChatStore({ repo, client: net.client, wifiIp: async () => null, autoScan: false }).init();
    expect(await repo.countTrash()).toBe(1);
    now += 2 * 86_400_000;
    await new ChatStore({ repo, client: net.client, wifiIp: async () => null, autoScan: false }).init();
    expect(await repo.countTrash()).toBe(0);
  });

  test('重新產生最後一則回答：保留舊回答當版本，可以用 ‹ › 切換；送出時用看得到的那個版本', async () => {
    const { net, store } = await ready();
    let n = 0;
    net.hosts.get(A)!.reply = () => ({ lines: [{ message: { content: `答案${++n}` }, done: false }, { message: { content: '' }, done: true }] });
    await store.send('問題');
    await store.regenerate(store.getState().messages[1].id);
    let msgs = store.getState().messages;
    expect(msgs.map((m) => m.content)).toEqual(['問題', '答案2']);
    expect(msgs[1].versions).toEqual({ index: 2, total: 2 });
    expect(store.getState().undo).toBeNull(); // 後面沒有訊息，不用復原提示

    await store.switchVersion(msgs[1].id, -1);
    msgs = store.getState().messages;
    expect(msgs.map((m) => m.content)).toEqual(['問題', '答案1']);
    expect(msgs[1].versions).toEqual({ index: 1, total: 2 });

    await store.send('追問');
    expect(net.chatBodies().at(-1).messages.map((m: any) => m.content)).toEqual(['請用繁體中文（台灣用語）回答。', '問題', '答案1', '追問']);
  });

  test('重新產生中間的回答：後面的訊息先藏起來，可以復原', async () => {
    const { store } = await ready();
    await store.send('第一題');
    await store.send('第二題');
    const firstAnswer = store.getState().messages[1];
    await store.regenerate(firstAnswer.id);
    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().undo?.message).toBe('已刪掉後面的 2 則訊息');
    await store.undoLast();
    expect(store.getState().messages.map((m) => [m.content, m.id === firstAnswer.id])).toEqual([
      ['第一題', false],
      ['回答：第一題', true],
      ['第二題', false],
      ['回答：第二題', false],
    ]);
  });

  test('編輯重送後可以復原成原本的訊息', async () => {
    const { store } = await ready();
    await store.send('原本');
    const original = store.getState().messages.map((m) => m.id);
    await store.editAndResend(original[0], '改過');
    expect(store.getState().messages.map((m) => m.content)).toEqual(['改過', '回答：改過']);
    await store.undoLast();
    expect(store.getState().messages.map((m) => m.id)).toEqual(original);
  });

  test('移除電腦可以復原', async () => {
    const { store } = await ready();
    await store.removeHost(A);
    expect(store.getState().hosts).toEqual([]);
    expect(store.getState().undo?.message).toBe('已移除「192.168.1.20」');
    await store.undoLast();
    expect(store.getState().hosts.map((h) => h.label)).toEqual(['192.168.1.20']);
    expect(store.getState().models[A].list.length).toBeGreaterThan(0);
  });

  test('刪除所有對話可以復原', async () => {
    const { store } = await ready();
    await store.send('a');
    await store.newSession();
    await store.send('b');
    await store.deleteAllSessions();
    expect((await store.listSessions()).length).toBe(1);
    expect(store.getState().undo?.message).toBe('已刪除 2 段對話');
    await store.undoLast();
    expect((await store.listSessions()).map((s) => s.preview).sort()).toEqual(['回答：a', '回答：b']);
  });

  test('清除全部資料：幾秒內可以復原；時間到才真的刪', async () => {
    const { store, repo } = await ready();
    await store.send('a');
    await store.resetAll();
    expect(store.getState().hosts).toEqual([]);
    await store.undoLast();
    expect(store.getState().hosts.map((h) => h.url)).toEqual([A]);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['a', '回答：a']);

    await store.resetAll();
    await store.dismissUndo(); // 提示時間到
    expect(await repo.countTrash()).toBe(0);
    expect(await repo.listHosts()).toEqual([]);
  });

  test('清除全部資料後幾秒內從最近刪除救回的對話：時間到也留著（電腦、設定照樣清掉）', async () => {
    const { store, repo } = await ready();
    await store.send('a');
    await store.newSession();
    await store.send('b');
    // 本來就在最近刪除的也一起清掉
    await store.send('c');
    const old = store.getState().session!.id;
    await store.deleteSession(old);
    await store.dismissUndo();
    await store.resetAll();
    const keep = (await store.listTrash()).find((s) => s.preview === '回答：a')!;
    await store.restoreSession(keep.id);
    await store.dismissUndo(); // 提示時間到
    expect((await store.listSessions()).map((s) => s.preview)).toContain('回答：a');
    // 本來就在最近刪除的那段（b、c）真的刪掉了
    expect(await repo.getSession(old)).toBeNull();
    expect(await repo.countTrash()).toBe(0);
    expect(await repo.listHosts()).toEqual([]);
  });

  test('清除全部資料後救回、打開比較舊的那段：時間到也不會被換到別段', async () => {
    const { store } = await ready();
    await store.send('a');
    const older = store.getState().session!.id;
    await store.newSession();
    await store.send('b');
    await store.resetAll();
    for (const s of await store.listTrash()) await store.restoreSession(s.id);
    await store.openSession(older);
    await store.dismissUndo(); // 提示時間到
    expect(store.getState().session?.id).toBe(older);
  });

  test('清除全部資料後救回一段、接著又刪掉它：照樣進最近刪除，按復原救得回來', async () => {
    const { store, repo } = await ready();
    await store.send('a');
    await store.resetAll();
    const keep = (await store.listTrash()).find((s) => s.preview === '回答：a')!;
    await store.restoreSession(keep.id);
    await store.deleteSession(keep.id);
    expect(await repo.getSession(keep.id)).not.toBeNull();
    await store.undoLast();
    expect((await store.listSessions()).map((s) => s.id)).toContain(keep.id);
  });

  test('清除全部資料後還在可以復原的時候就關掉 App：下次打開時真的刪掉（救回的留著）', async () => {
    const { net, store, repo } = await ready();
    await store.send('a');
    await store.newSession();
    await store.send('b');
    await store.resetAll();
    const keep = (await store.listTrash()).find((s) => s.preview === '回答：a')!;
    await store.restoreSession(keep.id);
    const again = new ChatStore({ repo, client: net.client, wifiIp: async () => null, autoScan: false });
    await again.init();
    expect(await repo.countTrash()).toBe(0);
    expect(await repo.listHosts()).toEqual([]);
    expect((await repo.listSessions()).map((s) => s.preview)).toContain('回答：a');
  });

  test('下一個操作開始時，上一個沒按復原的就確定了', async () => {
    const { store } = await ready();
    await store.send('a');
    await store.send('b');
    await store.deleteMessage(store.getState().messages[3].id);
    await store.deleteMessage(store.getState().messages[2].id);
    expect(store.getState().undo?.message).toBe('已刪除訊息');
    await store.undoLast();
    // 只復原最後一次刪除
    expect(store.getState().messages.map((m) => m.content)).toEqual(['a', '回答：a', 'b']);
  });
});

describe('討論串', () => {
  async function twoTopics() {
    const ctx = await ready();
    await ctx.store.send('台南有什麼小吃');
    await ctx.store.send('Go 怎麼裝');
    const main = ctx.store.getState().session!;
    const [question, answer] = ctx.store.getState().messages;
    return { ...ctx, main, question, answer };
  }

  test('針對某一題開討論串：只帶那一題的問與答，送給模型的也只有這些（不帶別的主題）', async () => {
    const { store, net, main, answer } = await twoTopics();
    await store.openThread(answer.id);
    const thread = store.getState().session!;
    expect(thread).toMatchObject({ parentId: main.id, title: '台南有什麼小吃' });
    expect(store.getState().messages.map((m) => [m.role, m.content, m.detail])).toEqual([
      ['user', '台南有什麼小吃', 'thread-root'],
      ['assistant', '回答：台南有什麼小吃', 'thread-root'],
    ]);
    const titles = net.titleBodies().length;
    await store.send('牛肉湯哪家好');
    const sent = net.chatBodies().at(-1).messages.map((m: any) => m.content);
    expect(sent.slice(1)).toEqual(['台南有什麼小吃', '回答：台南有什麼小吃', '牛肉湯哪家好']);
    // 討論串的標題就是那一題，不另外請模型取
    expect(net.titleBodies()).toHaveLength(titles);
  });

  test('回到原對話：看得到問了幾次；同一題再開是同一個討論串', async () => {
    const { store, main, question, answer } = await twoTopics();
    await store.openThread(question.id);
    const thread = store.getState().session!.id;
    await store.send('牛肉湯哪家好');
    await store.leaveThread();
    expect(store.getState().session?.id).toBe(main.id);
    expect(store.getState().threads).toEqual({ [question.id]: { id: thread, count: 1 } });
    await store.openThread(answer.id);
    expect(store.getState().session?.id).toBe(thread);
  });

  test('什麼都沒問就回去：不留空的討論串', async () => {
    const { store, repo, main, answer } = await twoTopics();
    await store.openThread(answer.id);
    const thread = store.getState().session!.id;
    await store.leaveThread();
    expect(store.getState().session?.id).toBe(main.id);
    expect(store.getState().threads).toEqual({});
    expect(await repo.getSession(thread)).toBeNull();
  });

  test('討論串裡不能再開討論串；帶進去的那一題不能重新產生、編輯、刪除', async () => {
    const { store, net, answer } = await twoTopics();
    await store.openThread(answer.id);
    const thread = store.getState().session!.id;
    const [rootQ, rootA] = store.getState().messages;
    await store.openThread(rootA.id);
    expect(store.getState().session?.id).toBe(thread);
    const before = net.chatBodies().length;
    await store.regenerate(rootA.id);
    await store.editAndResend(rootQ.id, '改掉');
    await store.deleteMessage(rootQ.id);
    expect(net.chatBodies()).toHaveLength(before);
    expect(store.getState().messages.map((m) => m.content)).toEqual(['台南有什麼小吃', '回答：台南有什麼小吃']);
  });

  test('刪掉目前的討論串：回到它那段對話，可以復原', async () => {
    const { store, main, question, answer } = await twoTopics();
    await store.openThread(answer.id);
    const thread = store.getState().session!.id;
    await store.send('牛肉湯哪家好');
    await store.deleteSession(thread);
    expect(store.getState().session?.id).toBe(main.id);
    await store.undoLast();
    expect(store.getState().session?.id).toBe(thread);
    await store.leaveThread();
    expect(store.getState().threads[question.id]?.count).toBe(1);
  });
});

describe('設定', () => {
  test('偏好設定會存起來，重開 App 還在', async () => {
    const { net, store, repo } = await ready();
    expect(store.getState().prefs).toEqual({ language: 'system', toolsOff: [] });
    await store.setPref('language', 'en');
    const again = new ChatStore({ repo, client: net.client, wifiIp: async () => null, autoScan: false });
    await again.init();
    expect(again.getState().prefs).toEqual({ language: 'en', toolsOff: [] });
    await again.setPref('language', 'system');
  });

  test('AI 用 App 的語言回答', async () => {
    const { net, store } = await ready();
    await store.send('hi');
    expect(net.chatBodies().at(-1).messages[0]).toEqual({ role: 'system', content: REPLY_PROMPTS['zh-Hant'] });
    await store.setPref('language', 'en');
    await store.send('hi3');
    expect(net.chatBodies().at(-1).messages[0].content).toBe('Please reply in English.');
  });

  test('「跟著系統」用手機的語言', async () => {
    const net = new FakeOllamaNet();
    const store = new ChatStore({ repo: new Repo(memoryDb()), client: net.client, wifiIp: async () => null, autoScan: false, deviceLanguage: () => 'en' });
    await store.init();
    expect(store.appLanguage()).toBe('en');
    await store.setPref('language', 'zh-Hant');
    expect(store.appLanguage()).toBe('zh-Hant');
  });

  test('從備份還原：資料換成備份的；幾秒內可以復原', async () => {
    const { net, store } = await ready();
    await store.send('現在的對話');
    // 準備另一支手機的備份
    const otherDb = memoryDb();
    const other = new ChatStore({ repo: new Repo(otherDb), client: net.client, wifiIp: async () => null, autoScan: false });
    await other.init();
    await other.addHost('192.168.1.20', { label: '舊電腦' });
    await other.send('備份裡的對話');

    const withMemory = store as any;
    withMemory.deps.openMemoryDb = async () => memoryDb();
    await store.restoreFromBackup(otherDb);
    expect(store.getState().messages[0].content).toBe('備份裡的對話');
    expect(store.getState().hosts.map((h) => h.label)).toEqual(['舊電腦']);
    expect(store.getState().undo?.message).toBe('已從備份還原');
    await store.undoLast();
    expect(store.getState().messages[0].content).toBe('現在的對話');
    expect(store.getState().hosts.map((h) => h.label)).toEqual(['192.168.1.20']);
  });

  test('從備份還原：不是備份檔就報錯，資料不動', async () => {
    const { store } = await ready();
    await store.send('現在的對話');
    const bad = memoryDb();
    await bad.exec('CREATE TABLE notes (id INTEGER)');
    await expect(store.restoreFromBackup(bad)).rejects.toThrow('這個檔案不是這個 App 的備份。');
    expect(store.getState().messages[0].content).toBe('現在的對話');
  });
});
