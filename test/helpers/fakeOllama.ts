import { OllamaClient, type FetchLike } from '../../src/lib/ollama';
import { TITLE_PROMPTS } from '../../src/state/chatStore';

const isTitlePrompt = (s: unknown) => Object.values(TITLE_PROMPTS).includes(s as never);

export type FakeModel = { name: string; vision?: boolean; think?: 'toggle' | 'levels'; ctx?: number; engine?: string; engineName?: string; canLoad?: boolean };

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
  /** 這個位址是 Local AI 小幫手（後面接這台假 Ollama） */
  helper?: FakeHelper;
};

export type FakeHelper = {
  id: string;
  name: string;
  /** 電腦上按了「配對新手機」時的配對碼；null 代表沒在配對 */
  code: string | null;
  /** 發出去還有效的權杖 */
  tokens: string[];
  /** 配對時手機報的名字 */
  devices: string[];
  /** /helper/v1/info 回報的配備與可以下載的引擎 */
  hardware?: unknown;
  downloadEngines?: string[];
  /** 下載工作：每問一次進度多一半，完成時模型加進清單；名稱 nope 會失敗 */
  jobs?: any[];
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
    return this.calls.filter((c) => c.path === '/api/chat' && !isTitlePrompt(c.body.messages[0]?.content)).map((c) => c.body);
  }

  /** 自動取標題的請求 */
  titleBodies(): any[] {
    return this.calls.filter((c) => c.path === '/api/chat' && isTitlePrompt(c.body.messages[0]?.content)).map((c) => c.body);
  }

  /** 小幫手：url 是小幫手的位址（:11480），後面接一台假 Ollama */
  addHelper(url: string, helper: Partial<FakeHelper> & { id: string; name: string }, host: Partial<FakeHost> = {}): FakeHost {
    return this.addHost(url, { ...host, helper: { code: null, tokens: [], devices: [], ...helper } });
  }

  client = (url: string, token?: string) => new OllamaClient(url, { fetch: this.fetch, token, timeouts: { request: 200, firstToken: 2000, idle: 2000 } });

  fetch: FetchLike = async (url, init) => {
    const m = /^(https?:\/\/[^/]+)(\/.*)$/.exec(url)!;
    const [base, path] = [m[1], m[2]];
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ url: base, path, body });
    const host = this.hosts.get(base);
    if (!host || !host.online) throw new TypeError('Network request failed');
    const json = (data: unknown, status = 200) => respond(status, [JSON.stringify(data)], init.signal);

    const helper = host.helper;
    if (helper) {
      if (path === '/helper/v1/hello') return json({ app: 'local-ai-helper', id: helper.id, name: helper.name, version: '0.2.0', pairing: helper.code !== null });
      if (path === '/helper/v1/pair') {
        if (helper.code === null) return json({ error: 'pairing is not open', code: 'not_pairing' }, 409);
        if (body.code !== helper.code) return json({ error: 'wrong pairing code', code: 'bad_code' }, 403);
        const token = `token-${helper.tokens.length + 1}`;
        helper.tokens.push(token);
        helper.devices.push(body.deviceName);
        helper.code = null;
        return json({ token, deviceId: `d${helper.tokens.length}`, helper: { id: helper.id, name: helper.name } });
      }
      const auth = init.headers?.Authorization ?? '';
      if (!helper.tokens.some((tk) => auth === `Bearer ${tk}`)) return json({ error: 'pair this phone first', code: 'not_paired' }, 401);
      const jobs = (helper.jobs ??= []);
      if (path === '/helper/v1/info') return json({ id: helper.id, name: helper.name, download_engines: helper.downloadEngines ?? ['ollama'], hardware: helper.hardware ?? { memory_bytes: 32e9, gpus: [], unified: false } });
      if (path === '/helper/v1/downloads' && init.method === 'GET') {
        for (const j of jobs) {
          if (j.status !== 'downloading') continue;
          if (j.model === 'nope') Object.assign(j, { status: 'failed', code: 'not_found', error: 'file does not exist' });
          else if ((j.completed += j.total / 2) >= j.total) {
            j.status = 'done';
            host.models.push({ name: j.model });
          }
        }
        return json({ downloads: jobs });
      }
      if (path === '/helper/v1/downloads') {
        const job = { id: `j${jobs.length + 1}`, model: body.model, engine: body.engine ?? 'ollama', status: 'downloading', completed: 0, total: 1000, cancellable: body.engine !== 'lmstudio' };
        jobs.push(job);
        return json(job, 202);
      }
      const stop = /^\/helper\/v1\/downloads\/(.+)$/.exec(path);
      if (stop && init.method === 'DELETE') {
        const j = jobs.find((x) => x.id === stop[1]);
        if (j?.status === 'downloading') j.status = 'cancelled';
        else helper.jobs = jobs.filter((x) => x !== j);
        return respond(204, [], init.signal);
      }
    } else if (path.startsWith('/helper/')) {
      return json({ error: 'not found' }, 404);
    }

    switch (path) {
      case '/api/version':
        return json({ version: host.version });
      case '/api/tags':
        return json({
          models: host.models.map((x) => ({ name: x.name, ...(x.engine ? { engine: x.engine, engine_name: x.engineName ?? '', can_load: x.canLoad ?? true } : {}) })),
        });
      case '/api/pull': {
        if (body.model === 'nope') return respond(200, [JSON.stringify({ status: 'pulling manifest' }) + '\n', JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n'], init.signal);
        host.models.push({ name: body.model });
        const lines = [
          { status: 'pulling manifest' },
          { status: 'pulling a', digest: 'a', total: 800, completed: 400 },
          { status: 'pulling b', digest: 'b', total: 200, completed: 200 },
          { status: 'pulling a', digest: 'a', total: 800, completed: 800 },
          { status: 'success' },
        ];
        return respond(200, lines.map((l) => JSON.stringify(l) + '\n'), init.signal);
      }
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
        const isTitle = isTitlePrompt(body.messages[0]?.content);
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
