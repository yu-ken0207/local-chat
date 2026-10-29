/// <reference types="node" />
/**
 * 手機上動手做事的題庫評測：用跟 App 一模一樣的工具定義與系統提示詞，問電腦上的模型，
 * 看它第一次回答有沒有叫對工具、時間填得對不對。不會真的動任何行事曆。
 *
 * 用法（要 Node 22.6 以上）：
 *   npx -y tsx@4.19.2 eval/tools/run.ts --host http://127.0.0.1:11434 --models gemma4:e4b,gemma4:12b [--think qwen3:4b] [--only id1,id2] [--tag v2]
 * 結果寫到 eval/tools/results/<tag>/<日期>-<模型>.json 與 summary-<日期>.md
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { setLanguage } from '../../src/i18n';
import { REPLY_PROMPTS } from '../../src/lib/history';
import { parseArguments, parseLocal, toOllamaTools, toolSystemPrompt, validateInput, type PhoneTool } from '../../src/lib/tools';
import { askUserTool } from '../../src/tools/ask';
import { calendarTools, type CalendarApi } from '../../src/tools/calendar';

type Expected = { name: string; args?: Record<string, string | number | boolean> };
type Case = { id: string; say: string; image?: string; lang?: 'zh-Hant' | 'en'; expect: { tools?: Expected[]; none?: boolean; noWrite?: boolean } };
type Call = { name: string; args: Record<string, unknown>; valid: boolean; problem: string };
type Result = { id: string; ms: number; calls: Call[]; text: string; toolOk: boolean; argsOk: boolean; error?: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const host = arg('host', 'http://127.0.0.1:11434');
const models = arg('models').split(',').filter(Boolean);
const thinkModels = new Set(arg('think').split(',').filter(Boolean));
const only = new Set(arg('only').split(',').filter(Boolean));

const bank = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8')) as { now: string; timeZone: string; cases: Case[] };
const now = parseLocal(bank.now).getTime();
// 工具只拿定義，不會真的執行
const noop = (() => {
  throw new Error('not used');
}) as never;
const api: CalendarApi = { allowCalendar: noop, allowReminders: noop, calendars: noop, defaultCalendarId: noop, events: noop, createEvent: noop, deleteEvent: noop, createReminder: noop, deleteReminder: noop };
const tools: PhoneTool[] = [...calendarTools(api), askUserTool()];
const WRITE = new Set(['create_event', 'create_reminder']);

function checkCall(name: string, raw: unknown): Call {
  const tool = tools.find((x) => x.name === name);
  if (!tool) return { name, args: {}, valid: false, problem: 'unknown tool' };
  const parsed = parseArguments(raw);
  const checked = parsed.ok ? validateInput(tool.inputSchema, parsed.value) : parsed;
  if (!checked.ok) return { name, args: parsed.ok ? parsed.value : { raw }, valid: false, problem: checked.error };
  const problem = tool.check?.(checked.value, { now }) ?? '';
  return { name, args: checked.value, valid: !problem, problem };
}

function argsMatch(expected: Expected['args'] = {}, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, want]) => {
    const got = actual[key];
    if (got === undefined) return false;
    if (key === 'title' || key === 'calendar') return String(got).toLowerCase().includes(String(want).toLowerCase());
    if (typeof want === 'string') return String(got).startsWith(want);
    return got === want;
  });
}

function score(c: Case, calls: Call[]): { toolOk: boolean; argsOk: boolean } {
  const e = c.expect;
  if (e.none) return { toolOk: calls.length === 0, argsOk: calls.length === 0 };
  if (e.noWrite) {
    const ok = !calls.some((x) => WRITE.has(x.name));
    return { toolOk: ok, argsOk: ok };
  }
  const wanted = e.tools ?? [];
  const writesOk = calls.filter((x) => WRITE.has(x.name)).length <= wanted.filter((x) => WRITE.has(x.name)).length;
  const toolOk = wanted.every((w) => calls.filter((x) => x.name === w.name).length >= wanted.filter((x) => x.name === w.name).length) && writesOk;
  const used = new Set<Call>();
  const argsOk =
    toolOk &&
    wanted.every((w) => {
      const hit = calls.find((x) => !used.has(x) && x.name === w.name && x.valid && argsMatch(w.args, x.args));
      if (hit) used.add(hit);
      return !!hit;
    });
  return { toolOk, argsOk };
}

async function ask(model: string, c: Case): Promise<Result> {
  const lang = c.lang ?? 'zh-Hant';
  setLanguage(lang);
  const images = c.image ? [readFileSync(join(HERE, c.image)).toString('base64')] : undefined;
  const body = {
    model,
    stream: false,
    think: thinkModels.has(model),
    tools: toOllamaTools(tools),
    messages: [
      { role: 'system', content: REPLY_PROMPTS[lang] + '\n\n' + toolSystemPrompt(now, bank.timeZone) },
      { role: 'user', content: c.say, ...(images ? { images } : {}) },
    ],
  };
  const start = Date.now();
  try {
    const res = await fetch(`${host}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    const out = (await res.json()) as any;
    if (!res.ok || out.error) throw new Error(out.error ?? `HTTP ${res.status}`);
    const calls = ((out.message?.tool_calls ?? []) as any[]).map((x) => checkCall(String(x.function?.name ?? ''), x.function?.arguments));
    return { id: c.id, ms: Date.now() - start, calls, text: String(out.message?.content ?? '').slice(0, 300), ...score(c, calls) };
  } catch (e) {
    return { id: c.id, ms: Date.now() - start, calls: [], text: '', toolOk: false, argsOk: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const describeCall = (x: Call) => `${x.name}(${JSON.stringify(x.args)})${x.valid ? '' : ` ✗ ${x.problem}`}`;

async function main() {
  const cases = bank.cases.filter((c) => only.size === 0 || only.has(c.id));
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(HERE, 'results', arg('tag', 'latest'));
  mkdirSync(dir, { recursive: true });
  const lines = [`# 題庫評測 ${day}`, '', `電腦：${host}；題數：${cases.length}；今天設定為 ${bank.now}（${bank.timeZone}）`, '', '| 模型 | 叫對工具 | 工具和內容都對 | 平均秒數 |', '|---|---|---|---|'];
  const details: string[] = [];
  for (const model of models) {
    // 先載入一次（不算時間）
    await fetch(`${host}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: '30m' }) }).catch(() => {});
    const results: Result[] = [];
    for (const c of cases) {
      const r = await ask(model, c);
      results.push(r);
      console.log(`${model}\t${c.id}\t${r.toolOk ? 'tool✓' : 'tool✗'}\t${r.argsOk ? 'args✓' : 'args✗'}\t${(r.ms / 1000).toFixed(1)}s\t${r.error ?? r.calls.map(describeCall).join(' ; ') ?? ''}`);
    }
    writeFileSync(join(dir, `${day}-${model.replace(/[:/]/g, '_')}.json`), JSON.stringify(results, null, 2));
    const pct = (n: number) => `${n}/${results.length}（${Math.round((n / results.length) * 100)}%）`;
    const avg = results.reduce((s, r) => s + r.ms, 0) / results.length / 1000;
    lines.push(`| ${model} | ${pct(results.filter((r) => r.toolOk).length)} | ${pct(results.filter((r) => r.argsOk).length)} | ${avg.toFixed(1)} |`);
    details.push('', `## ${model}`, '', '沒全對的題目：', '');
    for (const r of results.filter((x) => !x.argsOk)) {
      const c = cases.find((x) => x.id === r.id)!;
      details.push(`- **${r.id}**「${c.say}」：${r.error ? `錯誤 ${r.error}` : r.calls.length ? r.calls.map(describeCall).join('；') : `沒叫工具，回答「${r.text.replace(/\s+/g, ' ').slice(0, 80)}」`}`);
    }
  }
  writeFileSync(join(dir, `summary-${day}.md`), [...lines, ...details, ''].join('\n'));
  console.log(lines.join('\n'));
}

void main();
