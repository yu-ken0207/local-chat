/**
 * @jest-environment node
 *
 * 打真的 Ollama 主機（不在 npm test 裡跑）：
 *   LIVE_HOSTS=http://<電腦一>:11434,http://<電腦二>:11434 LIVE_CHAT_HOST=http://<電腦一>:11434 npm run test:live
 * LIVE_CHAT_HOST 會載入一個小模型（LIVE_CHAT_MODEL，預設 gemma4:e2b）來測串流與看圖，測完如果原本沒載入就卸載。
 * 別把 LIVE_CHAT_HOST 指到正在給其他服務用、顯示卡吃緊的主機。
 * LIVE_SCAN_FROM=192.168.50.170 會假裝手機在這個位址，掃同網段，期望找到 LIVE_SCAN_EXPECT。
 */
/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import { hostUrl, scanHosts, subnetCandidates } from '../../src/lib/discovery';
import { fmtTokPerSec } from '../../src/lib/format';
import { OllamaClient, type ChatDelta } from '../../src/lib/ollama';
import { nodeFetch } from './nodeFetch';

const HOSTS = (process.env.LIVE_HOSTS ?? '').split(',').filter(Boolean);
const CHAT_HOST = process.env.LIVE_CHAT_HOST ?? '';
const CHAT_MODEL = process.env.LIVE_CHAT_MODEL ?? 'gemma4:e2b';
const SCAN_FROM = process.env.LIVE_SCAN_FROM ?? '';
const SCAN_EXPECT = process.env.LIVE_SCAN_EXPECT ?? '';

const client = (url: string) => new OllamaClient(url, { fetch: nodeFetch });

jest.setTimeout(240_000);

for (const url of HOSTS) {
  describe(`主機 ${url}`, () => {
    test('版本與回應時間', async () => {
      const v = await client(url).version();
      expect(v.version).toMatch(/^\d+\.\d+/);
      console.log(`${url} Ollama ${v.version}，${v.latencyMs} ms`);
    });

    test('模型清單：至少一個看得懂圖的模型，沒有雜湊名稱與嵌入模型', async () => {
      const models = await client(url).listModels();
      expect(models.some((m) => m.vision)).toBe(true);
      expect(models.every((m) => !/:[0-9a-f]{64}$/.test(m.name))).toBe(true);
      expect(models.some((m) => /embed|bge-m3/.test(m.name))).toBe(false);
      console.log(models.map((m) => `${m.name}${m.vision ? ' 👁' : ''}${m.think ? ` 思考:${m.think.kind}` : ''} ctx=${m.contextLength}`).join('\n'));
    });

    test('已載入模型', async () => {
      const loaded = await client(url).loaded();
      expect(Array.isArray(loaded)).toBe(true);
    });
  });
}

(CHAT_HOST ? describe : describe.skip)(`聊天主機 ${CHAT_HOST}（${CHAT_MODEL}）`, () => {
  const c = client(CHAT_HOST);
  let wasLoaded = true;

  beforeAll(async () => {
    wasLoaded = (await c.loaded()).some((m) => m.name === CHAT_MODEL);
  });

  afterAll(async () => {
    if (!wasLoaded) await c.unload(CHAT_MODEL);
  });

  test('預熱後出現在已載入清單', async () => {
    await c.preload(CHAT_MODEL, '5m');
    expect((await c.loaded()).some((m) => m.name === CHAT_MODEL)).toBe(true);
  });

  test('開思考：先收到思考、再收到回答，最後有統計', async () => {
    const deltas: ChatDelta[] = [];
    const r = await c.chat(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: '一個籃子有 3 顆蘋果，拿走 1 顆再放進 4 顆，現在幾顆？簡短回答' }], think: true },
      (d) => deltas.push(d)
    );
    const thinking = deltas.map((d) => d.thinking ?? '').join('');
    const content = deltas.map((d) => d.content ?? '').join('');
    expect(thinking.length).toBeGreaterThan(0);
    expect(content).toMatch(/6|六/);
    expect(deltas.findIndex((d) => d.thinking)).toBeLessThan(deltas.findIndex((d) => d.content));
    expect(r.evalCount).toBeGreaterThan(0);
    console.log(`思考 ${thinking.length} 字，回答「${content.trim()}」，${fmtTokPerSec(r.evalCount, r.evalDurationNs)}`);
  });

  test('關思考：不會收到思考內容', async () => {
    const deltas: ChatDelta[] = [];
    await c.chat({ model: CHAT_MODEL, messages: [{ role: 'user', content: '說「好」' }], think: false }, (d) => deltas.push(d));
    expect(deltas.some((d) => d.thinking)).toBe(false);
    expect(deltas.some((d) => d.content)).toBe(true);
  });

  test('看圖：認得出紅色圓形', async () => {
    const image = readFileSync(join(__dirname, 'fixtures', 'red-circle.jpg')).toString('base64');
    let content = '';
    await c.chat(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: '圖裡的圖形是什麼顏色？只回答顏色', images: [image] }], think: false },
      (d) => (content += d.content ?? '')
    );
    expect(content).toMatch(/紅|red/i);
  });

  test('多輪對話：記得前面說過的事', async () => {
    let content = '';
    await c.chat(
      {
        model: CHAT_MODEL,
        messages: [
          { role: 'user', content: '我的名字叫小凱，記住。' },
          { role: 'assistant', content: '好的，小凱。' },
          { role: 'user', content: '我叫什麼名字？只回答名字' },
        ],
        think: false,
      },
      (d) => (content += d.content ?? '')
    );
    expect(content).toContain('小凱');
  });

  test('中途停止', async () => {
    const controller = new AbortController();
    let got = '';
    const p = c.chat(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: '從 1 數到 300，用逗號隔開' }], think: false },
      (d) => {
        got += d.content ?? '';
        if (got.length > 20) controller.abort();
      },
      controller.signal
    );
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    expect(got.length).toBeGreaterThan(20);
  });
});

(SCAN_FROM ? test : test.skip)(`掃描 ${SCAN_FROM} 所在網段，找到 ${SCAN_EXPECT}`, async () => {
  const start = Date.now();
  const found = await scanHosts(
    subnetCandidates(SCAN_FROM).map((ip) => hostUrl(ip)),
    async (url) => (await new OllamaClient(url, { fetch: nodeFetch }).version(800)).version,
    { concurrency: 32 }
  );
  console.log(`掃 253 個位址花 ${((Date.now() - start) / 1000).toFixed(1)} 秒，找到：${found.map((f) => f.url).join(', ')}`);
  expect(found.map((f) => f.url)).toContain(hostUrl(SCAN_EXPECT));
  expect(Date.now() - start).toBeLessThan(30_000);
});
