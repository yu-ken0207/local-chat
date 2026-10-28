import { fetch as expoFetch } from 'expo/fetch';

import { NdjsonSplitter } from './ndjson';

// ---- 型別 ----

/** 模型的思考選項：開關型（gemma4 等），或分段型（gpt-oss 的 low / medium / high） */
export type ThinkOption = { kind: 'toggle' } | { kind: 'levels'; levels: string[]; defaultLevel: string };
/** 送給 Ollama 的 think 參數：開關型用 true / false，分段型用等級字串 */
export type ThinkSetting = boolean | string;

export type ModelInfo = {
  name: string;
  vision: boolean;
  think: ThinkOption | null;
  /** 模型本身支援的最大上下文（實際執行時通常更小，要看 /api/ps） */
  contextLength: number | null;
  family: string;
  parameterSize: string;
  quantization: string;
};

export type LoadedModel = { name: string; sizeVram: number; contextLength: number | null; expiresAt: string };

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string; images?: string[] };

export type ChatDelta = { content?: string; thinking?: string };

export type ChatResult = {
  doneReason: string;
  evalCount: number;
  evalDurationNs: number;
  promptEvalCount: number;
  totalDurationNs: number;
  loadDurationNs: number;
};

export type OllamaErrorKind = 'http' | 'network' | 'timeout' | 'cancelled' | 'server';

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

type ResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): unknown } } | null;
};
export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<ResponseLike>;

// ---- 解析 /api/show ----

/** 只有一串雜湊值、沒有正式名稱的模型（例如 llamacpp:3409…）不列出來 */
export function isHashName(name: string): boolean {
  return /:[0-9a-f]{64}$/.test(name);
}

/** 把 /api/show 的回應整理成 ModelInfo；不能聊天的模型（例如嵌入模型）回 null */
export function parseModelInfo(name: string, show: any): ModelInfo | null {
  const caps: string[] = show?.capabilities ?? [];
  if (!caps.includes('completion')) return null;
  const details = show?.details ?? {};
  return {
    name,
    vision: caps.includes('vision'),
    think: caps.includes('thinking') ? parseThink(show, details.family) : null,
    contextLength: findContextLength(show?.model_info),
    family: String(details.family ?? ''),
    parameterSize: String(details.parameter_size ?? ''),
    quantization: String(details.quantization_level ?? ''),
  };
}

function parseThink(show: any, family: string | undefined): ThinkOption {
  // 新版 Ollama（0.40 起）直接回報可用的思考選項，例如 { values: [false, true] } 或 { values: ['low','medium','high'] }
  const values: unknown[] | undefined = show?.thinking?.values;
  if (Array.isArray(values) && values.length > 0) {
    const levels = values.filter((v): v is string => typeof v === 'string');
    if (levels.length > 0) {
      const def = typeof show.thinking.default === 'string' ? show.thinking.default : levels[Math.floor(levels.length / 2)];
      return { kind: 'levels', levels, defaultLevel: def };
    }
    return { kind: 'toggle' };
  }
  // 舊版沒有回報：gpt-oss 一定是分段型，其他當開關型
  if (family === 'gptoss') return { kind: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium' };
  return { kind: 'toggle' };
}

function findContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number') return value;
  }
  return null;
}

// ---- 連線 ----

/** 把外部取消和逾時合成一個 AbortSignal；逾時可以用 touch() 重新計時（串流每收到一段就重算） */
function makeAbort(timeoutMs: number, outer?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = (ms = timeoutMs) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const onOuter = () => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener?.('abort', onOuter);
  touch();
  return {
    signal: controller.signal,
    touch,
    timedOut: () => timedOut,
    cancelled: () => !!outer?.aborted,
    done: () => {
      if (timer) clearTimeout(timer);
      outer?.removeEventListener?.('abort', onOuter);
    },
  };
}

function toOllamaError(e: any, abort: { timedOut(): boolean; cancelled(): boolean }, timeoutMs: number): OllamaError {
  if (e instanceof OllamaError) return e;
  if (abort.cancelled()) return new OllamaError('cancelled', '已取消');
  if (abort.timedOut()) return new OllamaError('timeout', `等了 ${Math.round(timeoutMs / 1000)} 秒沒有回應`);
  return new OllamaError('network', `連不到主機：${e?.message ?? e}`);
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** 第一次要先把模型載入顯示卡，大模型可能要 30～60 秒 */
export const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** 開始回答之後，超過這麼久沒有新字就當作斷線 */
export const IDLE_TIMEOUT_MS = 60_000;

export type ClientOptions = {
  fetch?: FetchLike;
  /** 一般請求、等第一個字、回答中途沒有新字的逾時（毫秒） */
  timeouts?: { request?: number; firstToken?: number; idle?: number };
};

export class OllamaClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeout: number;
  private readonly firstTokenTimeout: number;
  private readonly idleTimeout: number;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? (expoFetch as unknown as FetchLike);
    this.requestTimeout = options.timeouts?.request ?? DEFAULT_TIMEOUT_MS;
    this.firstTokenTimeout = options.timeouts?.firstToken ?? FIRST_TOKEN_TIMEOUT_MS;
    this.idleTimeout = options.timeouts?.idle ?? IDLE_TIMEOUT_MS;
  }

  private async json(path: string, body?: unknown, timeoutMs = this.requestTimeout, signal?: AbortSignal): Promise<any> {
    const abort = makeAbort(timeoutMs, signal);
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw new OllamaError('http', `HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      throw toOllamaError(e, abort, timeoutMs);
    } finally {
      abort.done();
    }
  }

  /** 確認是不是 Ollama，並量回應時間 */
  async version(timeoutMs = this.requestTimeout, signal?: AbortSignal): Promise<{ version: string; latencyMs: number }> {
    const start = Date.now();
    const data = await this.json('/api/version', undefined, timeoutMs, signal);
    if (typeof data?.version !== 'string') throw new OllamaError('server', '這個位址不是 Ollama');
    return { version: data.version, latencyMs: Date.now() - start };
  }

  /** 列出可以聊天的模型（含能力），依名稱排序 */
  async listModels(): Promise<ModelInfo[]> {
    const tags = await this.json('/api/tags');
    const names = [...new Set<string>((tags?.models ?? []).map((m: any) => String(m.name)))].filter(
      (name) => !isHashName(name)
    );
    const infos = await Promise.all(
      names.map(async (name) => {
        try {
          return parseModelInfo(name, await this.json('/api/show', { model: name }));
        } catch {
          return null; // 查不到的模型就略過
        }
      })
    );
    return infos.filter((m): m is ModelInfo => m !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 目前已載入顯示卡的模型 */
  async loaded(): Promise<LoadedModel[]> {
    const data = await this.json('/api/ps');
    return (data?.models ?? []).map((m: any) => ({
      name: String(m.name),
      sizeVram: Number(m.size_vram ?? 0),
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
      expiresAt: String(m.expires_at ?? ''),
    }));
  }

  /** 預熱：先把模型載入顯示卡，keepAlive 時間內不會被卸載 */
  async preload(model: string, keepAlive: string | number = '30m'): Promise<void> {
    await this.json('/api/generate', { model, keep_alive: keepAlive, stream: false }, this.firstTokenTimeout);
  }

  /** 卸載：讓模型離開顯示卡 */
  async unload(model: string): Promise<void> {
    await this.json('/api/generate', { model, keep_alive: 0, stream: false }, 60_000);
  }

  /** 串流聊天：每收到一段字就呼叫 onDelta，結束時回傳統計數字 */
  async chat(
    params: { model: string; messages: ChatMessage[]; think?: ThinkSetting },
    onDelta: (delta: ChatDelta) => void,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = { model: params.model, messages: params.messages, stream: true };
    if (params.think !== undefined) body.think = params.think;

    const abort = makeAbort(this.firstTokenTimeout, signal);
    let waitingMs = this.firstTokenTimeout;
    try {
      const res = await this.fetchImpl(this.baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw new OllamaError('http', `HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      if (!res.body) throw new OllamaError('server', '主機沒有回傳串流資料');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const splitter = new NdjsonSplitter();
      let final: any = null;
      const handle = (obj: any) => {
        if (obj?.error) throw new OllamaError('server', String(obj.error));
        const m = obj?.message;
        if (m?.thinking) onDelta({ thinking: String(m.thinking) });
        if (m?.content) onDelta({ content: String(m.content) });
        if (obj?.done) final = obj;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        waitingMs = this.idleTimeout;
        abort.touch(this.idleTimeout);
        if (value) splitter.push(decoder.decode(value, { stream: true })).forEach(handle);
      }
      splitter.push(decoder.decode()).forEach(handle);
      splitter.flush().forEach(handle);
      if (!final) throw new OllamaError('network', '回答還沒結束連線就斷了');
      return {
        doneReason: String(final.done_reason ?? ''),
        evalCount: Number(final.eval_count ?? 0),
        evalDurationNs: Number(final.eval_duration ?? 0),
        promptEvalCount: Number(final.prompt_eval_count ?? 0),
        totalDurationNs: Number(final.total_duration ?? 0),
        loadDurationNs: Number(final.load_duration ?? 0),
      };
    } catch (e) {
      throw toOllamaError(e, abort, waitingMs);
    } finally {
      abort.done();
    }
  }
}
