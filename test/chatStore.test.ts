/**
 * @jest-environment node
 */
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

async function setup(options: { wifi?: string | null } = {}) {
  const net = new FakeOllamaNet();
  net.addHost(A, { models: MODELS });
  const repo = new Repo(memoryDb());
  const events: ChatEvent[] = [];
  const store = new ChatStore({
    repo,
    client: net.client,
    wifiIp: async () => (options.wifi === undefined ? '192.168.1.10' : options.wifi),
    throttleMs: 5,
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

  test('改名、刪除主機', async () => {
    const { store } = await setup();
    await store.addHost('192.168.1.20');
    await store.renameHost(A, '書房');
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
    expect(store.getState().models[A].error).toContain('連不到主機');
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

  test('連不到主機：不留空白回答，加一則錯誤', async () => {
    const { net, store, events } = await ready();
    net.hosts.get(A)!.online = false;
    await store.send('hi');
    expect(store.getState().messages.map((m) => m.role)).toEqual(['user', 'error']);
    expect(store.getState().messages[1].content).toContain('連不到主機');
    expect(events).toEqual(['failed']);
  });

  test('模型回報錯誤', async () => {
    const { net, store } = await ready();
    net.hosts.get(A)!.reply = () => ({ lines: [{ error: 'model requires more system memory' }] });
    await store.send('hi');
    expect(store.getState().messages[1]).toMatchObject({ role: 'error', content: '沒有得到回答：model requires more system memory' });
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

  test('角色（系統提示詞）會送出', async () => {
    const { net, store } = await ready();
    await store.setSystemPrompt('你是巡檢專家');
    await store.send('hi');
    expect(net.chatBodies()[0].messages[0]).toEqual({ role: 'system', content: '你是巡檢專家' });
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

  test('匯出對話', async () => {
    const { store } = await ready();
    await store.send('你好');
    await store.titleTask;
    const { title, markdown } = await store.exportSession(store.getState().session!.id);
    expect(title).toBe(store.getState().session!.title);
    expect(markdown).toContain('**你**：你好');
    expect(markdown).toContain('**AI**（gemma4:31b）：');
    expect(markdown).toContain('- 模型：192.168.1.20 · gemma4:31b');
  });
});

describe('訊息操作與範本', () => {
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

  test('範本：啟動時載入預設、可以新增修改刪除', async () => {
    const { store } = await ready();
    const titles = () => store.getState().templates.map((t) => t.title);
    expect(titles()).toContain('翻譯成英文');
    await store.addTemplate(' 寫日報 ', '幫我整理今天的工作日報：\n');
    expect(titles().at(-1)).toBe('寫日報');
    const t = store.getState().templates.at(-1)!;
    await store.updateTemplate(t.id, '寫週報', '幫我整理本週工作：');
    expect(store.getState().templates.at(-1)).toMatchObject({ title: '寫週報', content: '幫我整理本週工作：' });
    await store.deleteTemplate(t.id);
    expect(titles()).not.toContain('寫週報');
  });
});
