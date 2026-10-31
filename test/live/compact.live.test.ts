/**
 * @jest-environment node
 *
 * 一般聊天快滿了自動整理（打真的模型，不在 npm test 裡跑）：
 *   LIVE_COMPACT_HOST=http://<電腦位址>:11434 LIVE_COMPACT_MODEL=gemma4:31b npm run test:live -- compact
 * 先講 12 個關鍵事實，再一直貼長文件把上下文撐到八成以上，等自動整理完，出 15 題考它；
 * 同樣的題目也問「整段原文都給它看」的，對照整理後少了什麼。
 */
/// <reference types="node" />
import { buildChatMessages, REPLY_PROMPTS } from '../../src/lib/history';
import { OllamaClient } from '../../src/lib/ollama';
import { ChatStore } from '../../src/state/chatStore';
import { Repo } from '../../src/store/repo';
import { memoryDb } from '../helpers/nodeDb';
import { QUIZ, answerKey, cheapestOf, fillUntilCompacted, grade, roster, quotes, tripDocs } from './fixtures/trip';
import { nodeFetch } from './nodeFetch';

const HOST = process.env.LIVE_COMPACT_HOST ?? '';
const MODEL = process.env.LIVE_COMPACT_MODEL ?? 'gemma4:31b';

jest.setTimeout(1_800_000);

(HOST ? describe : describe.skip)(`快滿了自動整理（${MODEL}）`, () => {
  test('撐到八成以上自動整理，之後考前面的事：對照整段原文少了什麼', async () => {
    const repo = new Repo(memoryDb());
    const client = (url: string) => new OllamaClient(url, { fetch: nodeFetch });
    const store = new ChatStore({ repo, client, wifiIp: async () => null, autoScan: false, probeTimeoutMs: 10_000 });
    await store.init();
    const url = (await store.addHost(new URL(HOST).host)).url;
    await store.loadModels(url);
    await store.selectModel(url, MODEL);
    if (store.currentModel()?.think?.kind === 'toggle') await store.setThink(false);
    const { text: rosterText, who057 } = roster();
    const quoteText = quotes();
    const cheapest = cheapestOf(quoteText);
    const log: string[] = [];
    const t0 = Date.now();
    const compacted = await fillUntilCompacted(store, tripDocs(rosterText, quoteText), (line) => {
      log.push(line);
      console.log(line);
    });
    const s = store.getState().session!;
    console.log(`\n=== 整理了沒：${compacted}（${((Date.now() - t0) / 1000).toFixed(0)} 秒）===\n摘要（${s.summary.length} 字，到第 ${s.summarySeq} 則）：\n${s.summary}\n`);
    expect(compacted).toBe(true);
    const show = (label: string) => {
      const c = store.getState().context;
      const line = `${label}：${c ? `${c.used.toLocaleString('en-US')}／${c.limit?.toLocaleString('en-US')}` : '沒有'}`;
      log.push(line);
      console.log(line);
    };

    // 整理後考它
    const all = store.getState().messages;
    await store.send(QUIZ);
    const afterAnswer = store.getState().messages.at(-1)!.content;
    show('考完');

    // 對照：整段原文都給它看（不整理）
    const history = buildChatMessages(all, { vision: false, systemPrompt: REPLY_PROMPTS['zh-Hant'] }).messages;
    let controlText = '';
    const control = await client(url).chat({ model: MODEL, think: false, messages: [...history, { role: 'user', content: QUIZ }] }, (d) => (controlText += d.content ?? ''));

    const key = answerKey(who057, cheapest);
    const a = grade(afterAnswer, key);
    const b = grade(controlText, key);
    const rows = key.map((_, i) => `${String(i + 1).padStart(2)}  整理後 ${a[i] ? '✓' : '✗'}  原文 ${b[i] ? '✓' : '✗'}`);
    console.log(`=== 整理後的回答 ===\n${afterAnswer}\n\n=== 整段原文的回答（prompt ${control.promptEvalCount} tokens）===\n${controlText}\n\n=== 對答案（057=${who057}、最便宜=${cheapest}）===\n${rows.join('\n')}\n整理後 ${a.filter(Boolean).length}/15、原文 ${b.filter(Boolean).length}/15\n${log.join('\n')}`);
    // 前 12 題是一開始講的關鍵事實：整理後要都還記得
    expect(a.slice(0, 12).filter(Boolean).length).toBeGreaterThanOrEqual(11);
  });
});
