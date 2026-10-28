import { OllamaClient, type FetchLike } from '../../src/lib/ollama';
import { TITLE_PROMPT } from '../../src/state/chatStore';

export type FakeModel = { name: string; vision?: boolean; think?: 'toggle' | 'levels'; ctx?: number };

export type FakeHost = {
  version: string;
  models: FakeModel[];
  loaded: string[];
  /** /api/ps 回報的實際上下文長度 */
  runtimeCtx: number;
  online: boolean;
  /** 自訂回答：回傳要串流送出的 JSON 物件；hang 代表送完後一直不結束（測停止） */
  reply?: (body: any) => { lines: unknown[]; hang?: boolean };
  /** 自動取標題的回答；沒設定時固定回「測試對話」 */
  titleReply?: (body: any) => { lines: unknown[] };
};

/**
 * 假的 Ollama 網路：可以有好幾台主機，照路徑回應 /api/version、tags、show、ps、generate、chat。
 * 沒登記的主機或 online=false 一律連不到。calls 記下所有請求。
 */
export class FakeOllamaNet {
  hosts = new Map<string, FakeHost>();
  calls: { url: string; path: string; body: any }[] = [];

  addHost(url: string, host: Partial<FakeHost> = {}): FakeHost {
    const h: FakeHost = { version: '0.40.0', models: [], loaded: [], runtimeCtx: 8192, online: true, ...host };
    this.hosts.set(url, h);
    return h;
  }

  /** 聊天請求（不含自動取標題的請求） */
  chatBodies(): any[] {
    return this.calls.filter((c) => c.path === '/api/chat' && c.body.messages[0]?.content !== TITLE_PROMPT).map((c) => c.body);
  }

  /** 自動取標題的請求 */
  titleBodies(): any[] {
    return this.calls.filter((c) => c.path === '/api/chat' && c.body.messages[0]?.content === TITLE_PROMPT).map((c) => c.body);
  }

  client = (url: string) => new OllamaClient(url, { fetch: this.fetch, timeouts: { request: 200, firstToken: 2000, idle: 2000 } });

  fetch: FetchLike = async (url, init) => {
    const m = /^(https?:\/\/[^/]+)(\/.*)$/.exec(url)!;
    const [base, path] = [m[1], m[2]];
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ url: base, path, body });
    const host = this.hosts.get(base);
    if (!host || !host.online) throw new TypeError('Network request failed');
    const json = (data: unknown, status = 200) => respond(status, [JSON.stringify(data)], init.signal);

    switch (path) {
      case '/api/version':
        return json({ version: host.version });
      case '/api/tags':
        return json({ models: host.models.map((x) => ({ name: x.name })) });
      case '/api/show': {
        const model = host.models.find((x) => x.name === body.model);
        if (!model) return json({ error: 'not found' }, 404);
        const caps = ['completion', ...(model.vision ? ['vision'] : []), ...(model.think ? ['thinking'] : [])];
        return json({
          capabilities: caps,
          ...(model.think === 'toggle' ? { thinking: { values: [false, true], default: true } } : {}),
          ...(model.think === 'levels' ? { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } } : {}),
          details: { family: 'fake', parameter_size: '1B', quantization_level: 'Q4' },
          model_info: { 'fake.context_length': model.ctx ?? 131072 },
        });
      }
      case '/api/ps':
        return json({
          models: host.loaded.map((name) => ({ name, size_vram: 1e9, context_length: host.runtimeCtx, expires_at: '2099-01-01T00:00:00Z' })),
        });
      case '/api/generate':
        if (body.keep_alive === 0) host.loaded = host.loaded.filter((x) => x !== body.model);
        else if (!host.loaded.includes(body.model)) host.loaded.push(body.model);
        return json({ done: true });
      case '/api/chat': {
        if (!host.models.some((x) => x.name === body.model)) return json({ error: `model "${body.model}" not found` }, 404);
        if (!host.loaded.includes(body.model)) host.loaded.push(body.model);
        const isTitle = body.messages[0]?.content === TITLE_PROMPT;
        const { lines, hang }: { lines: unknown[]; hang?: boolean } = isTitle
          ? (host.titleReply?.(body) ?? { lines: [{ message: { content: '測試對話' }, done: false }, { message: { content: '' }, done: true }] })
          : host.reply
            ? host.reply(body)
            : defaultReply(body);
        return respond(200, lines.map((l) => JSON.stringify(l) + '\n'), init.signal, hang);
      }
    }
    return json({ error: 'unknown path' }, 404);
  };
}

/** 預設回答：有開思考就先送一段思考，再把最後一句問題重複回來 */
function defaultReply(body: any): { lines: unknown[]; hang?: boolean } {
  const last = body.messages[body.messages.length - 1];
  const lines: unknown[] = [];
  if (body.think) lines.push({ message: { role: 'assistant', content: '', thinking: '想一下' }, done: false });
  lines.push({ message: { role: 'assistant', content: '回答：' }, done: false });
  lines.push({ message: { role: 'assistant', content: last.content }, done: false });
  lines.push({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 20, eval_duration: 5e8, prompt_eval_count: 100, total_duration: 1e9, load_duration: 1e6 });
  return { lines };
}

function respond(status: number, chunks: string[], signal?: AbortSignal, hang = false) {
  const encoder = new TextEncoder();
  let i = 0;
  const aborted = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
  return {
    ok: status < 400,
    status,
    text: async () => chunks.join(''),
    json: async () => JSON.parse(chunks.join('')),
    body: {
      getReader: () => ({
        read: async () => {
          if (signal?.aborted) throw aborted();
          if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
          if (hang) {
            return new Promise<never>((_, reject) => {
              if (signal?.aborted) reject(aborted());
              signal?.addEventListener('abort', () => reject(aborted()));
            });
          }
          return { done: true };
        },
      }),
    },
  };
}
