/**
 * @jest-environment node
 *
 * 快滿了整理成摘要：我們的做法跟 Codex 的做法比（打真的模型，不在 npm test 裡跑）：
 *   LIVE_COMPACT_HOST=http://<電腦位址>:11434 LIVE_COMPACT_MODEL=gemma4:31b npm run test:live -- compact-compare
 * 同一段撐到八成的對話，每種做法各整理、考 3 次（模型每次答得不一樣）：
 * - 我們：摘要（只摘前面）＋最近大約三成的原文（使用者和 AI 的都留）
 * - Codex 三成：整段歷史加「交接摘要」的指示（放不下從最舊的丟），新歷史＝使用者說過的話（從最近往前留三成）＋摘要
 * - Codex 原版：同上，使用者的話留到 2 萬 tokens（Codex 的預設）
 * - 原文：不整理，整段給它看（對照組）
 */
/// <reference types="node" />
import { estimateTokens } from '../../src/agents/discussion';
import { buildChatMessages, REPLY_PROMPTS } from '../../src/lib/history';
import { OllamaClient, type ChatMessage } from '../../src/lib/ollama';
import { ChatStore, SUMMARY_LEADS } from '../../src/state/chatStore';
import { Repo } from '../../src/store/repo';
import { memoryDb } from '../helpers/nodeDb';
import { QUIZ, answerKey, cheapestOf, fillUntilCompacted, grade, roster, quotes, tripDocs } from './fixtures/trip';
import { nodeFetch } from './nodeFetch';

const HOST = process.env.LIVE_COMPACT_HOST ?? '';
const MODEL = process.env.LIVE_COMPACT_MODEL ?? 'gemma4:31b';
const TRIALS = Number(process.env.LIVE_COMPACT_TRIALS ?? 3);

// Codex（codex-rs/core/templates/compact）原文照抄
const CODEX_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
const CODEX_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

jest.setTimeout(3_600_000);

const estimate = (list: ChatMessage[]) => list.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);

/** 從頭留到大約 n tokens，後面註明省略（Codex 的 truncate_text） */
function truncateTokens(text: string, n: number): string {
  let out = '';
  for (const ch of text) {
    if (estimateTokens(out + ch) > n) break;
    out += ch;
  }
  return `${out}…（後面省略）`;
}

(HOST ? describe : describe.skip)(`整理做法對照（${MODEL}）`, () => {
  test('同一段對話：我們、Codex 三成、Codex 原版、原文，各考 3 次', async () => {
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
    const key = answerKey(who057, cheapestOf(quoteText));
    const compacted = await fillUntilCompacted(store, tripDocs(rosterText, quoteText), (line) => console.log(line));
    expect(compacted).toBe(true);
    const sid = store.getState().session!.id;
    const limit = store.getState().context?.limit ?? 32_768;
    // 整理當下的對話（之後只拿來組要送的訊息，不再往裡面加）
    const all = (await repo.listMessages(sid)).filter((m) => m.role === 'user' || m.role === 'assistant');
    const system: ChatMessage = { role: 'system', content: REPLY_PROMPTS['zh-Hant'] };

    /** 問一次；電腦上的 AI 當掉（記憶體不夠）就等它重新載入再試，最多 3 次 */
    async function ask(messages: ChatMessage[], options?: Record<string, unknown>): Promise<{ text: string; prompt: number }> {
      for (let attempt = 1; ; attempt++) {
        try {
          let text = '';
          const r = await client(url).chat({ model: MODEL, think: false, messages, ...(options ? { options } : {}) }, (d) => (text += d.content ?? ''));
          return { text, prompt: r.promptEvalCount };
        } catch (e) {
          if (attempt >= 3) throw e;
          console.log(`  出錯，重試（${String(e)}）`);
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    }

    /** 我們的做法：用 App 本身的整理（第一次就是剛剛自動整理的那份，之後清掉重整） */
    async function ours(trial: number): Promise<{ context: ChatMessage[]; summary: string }> {
      if (trial > 0) {
        await (store as any).setSummary(sid, '', 0);
        expect(await store.compact(sid)).toBe(true);
      }
      const s = (await repo.getSession(sid))!;
      const kept = all.filter((m) => m.seq > s.summarySeq);
      const history = buildChatMessages(kept, { vision: false, systemPrompt: REPLY_PROMPTS['zh-Hant'] }).messages;
      history.splice(1, 0, { role: 'system', content: `${SUMMARY_LEADS['zh-Hant']}\n${s.summary}` });
      return { context: history, summary: s.summary };
    }

    /** Codex 的做法：整段歷史加指示（放不下從最舊的丟）→ 摘要；新歷史＝使用者的話（從最近往前留 budget）＋摘要 */
    async function codex(budget: number): Promise<{ context: ChatMessage[]; summary: string }> {
      const history = buildChatMessages(all, { vision: false, systemPrompt: REPLY_PROMPTS['zh-Hant'] }).messages;
      let dropped = 0;
      while (estimate(history) + estimateTokens(CODEX_PROMPT) + 2_500 > limit && history.length > 2) {
        history.splice(1, 1);
        dropped++;
      }
      if (dropped) console.log(`  Codex 整理前丟掉最舊的 ${dropped} 則`);
      const summary = (await ask([...history, { role: 'user', content: CODEX_PROMPT }], { num_predict: 1600 })).text.trim();
      const picked: string[] = [];
      let remaining = budget;
      for (const m of [...all].reverse()) {
        if (m.role !== 'user' || remaining <= 0) continue;
        const n = estimateTokens(m.content);
        if (n <= remaining) {
          picked.push(m.content);
          remaining -= n;
        } else {
          picked.push(truncateTokens(m.content, remaining));
          remaining = 0;
        }
      }
      picked.reverse();
      return { context: [system, ...picked.map((content) => ({ role: 'user' as const, content })), { role: 'user', content: `${CODEX_PREFIX}\n${summary}` }], summary };
    }

    const variants: { name: string; build: (trial: number) => Promise<{ context: ChatMessage[]; summary: string }> }[] = [
      { name: '我們', build: ours },
      { name: 'Codex 三成', build: () => codex(Math.floor(limit * 0.3)) },
      { name: 'Codex 原版', build: () => codex(20_000) },
      { name: '原文', build: async () => ({ context: buildChatMessages(all, { vision: false, systemPrompt: REPLY_PROMPTS['zh-Hant'] }).messages, summary: '' }) },
    ];
    const results: { name: string; scores: boolean[][]; prompts: number[]; summaryChars: number[] }[] = [];
    for (const v of variants) {
      const scores: boolean[][] = [];
      const prompts: number[] = [];
      const summaryChars: number[] = [];
      for (let trial = 0; trial < TRIALS; trial++) {
        const t = Date.now();
        const { context, summary } = await v.build(trial);
        const answer = await ask([...context, { role: 'user', content: QUIZ }]);
        const g = grade(answer.text, key);
        scores.push(g);
        prompts.push(answer.prompt);
        summaryChars.push(summary.length);
        console.log(`\n=== ${v.name} 第 ${trial + 1} 次（${((Date.now() - t) / 1000).toFixed(0)} 秒，送出 ${answer.prompt} tokens，摘要 ${summary.length} 字）：${g.filter(Boolean).length}/15 ===\n${trial === 0 && summary ? `--- 摘要 ---\n${summary}\n--- 回答 ---\n` : ''}${answer.text}`);
      }
      results.push({ name: v.name, scores, prompts, summaryChars });
    }

    const header = `題  ${results.map((r) => r.name.padEnd(8)).join(' ')}`;
    const rows = key.map((_, i) => `${String(i + 1).padStart(2)}  ${results.map((r) => `${r.scores.filter((s) => s[i]).length}/${TRIALS}`.padEnd(8)).join(' ')}`);
    const totals = `合計 ${results.map((r) => `${r.scores.flat().filter(Boolean).length}/${TRIALS * 15}`.padEnd(8)).join(' ')}`;
    const sizes = `送出 ${results.map((r) => `${Math.round(r.prompts.reduce((a, b) => a + b, 0) / r.prompts.length)}`.padEnd(8)).join(' ')}（tokens，平均）`;
    console.log(`\n=== 對照（057=${who057}）===\n${header}\n${rows.join('\n')}\n${totals}\n${sizes}`);
  });
});
