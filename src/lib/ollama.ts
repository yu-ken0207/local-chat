import { fetch as expoFetch } from 'expo/fetch';

import { NdjsonSplitter } from './ndjson';
import { t } from '../i18n';

// ---- 型別 ----

/** 模型的思考選項：開關型（gemma4 等）、分段型（gpt-oss 的 low / medium / high）、一定會思考（Qwen3 Thinking 這類，關不掉） */
export type ThinkOption = { kind: 'toggle' } | { kind: 'levels'; levels: string[]; defaultLevel: string } | { kind: 'always' };

/**
 * 一定會思考的模型在「不思考」時，Ollama 不會把思考分出來：思考混在回答前面，只看得到結尾的 </think>。
 * 把它拆回思考與回答；沒有思考的樣子回 null。
 */
export function splitThink(raw: string): { thinking: string; content: string } | null {
  const end = raw.indexOf('</think>');
  if (end < 0) {
    const t = raw.trimStart();
    return t.startsWith('<think>') ? { thinking: t.slice(7).trimStart(), content: '' } : null;
  }
  return { thinking: raw.slice(0, end).replace(/^\s*<think>/, '').trim(), content: raw.slice(end + 8).replace(/^\s+/, '') };
}
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
  /** 透過小幫手時：模型在哪個引擎（ollama、lmstudio、其他伺服器）；直接連 Ollama 是空的 */
  engine: string;
  engineName: string;
  /** 能不能預先載入／卸載（OpenAI 格式的伺服器不行） */
  canLoad: boolean;
};

/** 電腦的配備（小幫手回報）；手機用來判斷哪些模型跑得動 */
export type Hardware = { memoryBytes: number; gpus: { name: string; vramBytes: number }[]; unified: boolean };

/** 小幫手的資訊：可以下載模型的引擎（第一個是預設）、配備 */
export type HelperInfo = { downloadEngines: string[]; hardware: Hardware | null };

/** 下載模型的工作（小幫手在電腦上跑，或手機直接叫 Ollama 下載） */
export type DownloadJob = {
  id: string;
  model: string;
  engine: string;
  status: 'downloading' | 'done' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  /** 失敗原因：not_found（沒有這個模型）或其他 */
  code: string;
  error: string;
  cancellable: boolean;
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

export type OllamaErrorKind = 'http' | 'network' | 'timeout' | 'cancelled' | 'server' | 'unpaired';

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
    /** 小幫手回的錯誤代碼（bad_code、not_pairing…） */
    readonly code: string = ''
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** 小幫手的 hello：用來認出這是 Local AI 小幫手、是哪一台 */
export type HelperHello = { id: string; name: string; version: string; pairing: boolean };

/** 錯誤回應：小幫手是 {error, code}，Ollama 是 {error}；401 代表這支手機沒配對（或被移除） */
async function httpError(res: ResponseLike): Promise<OllamaError> {
  const text = await res.text();
  let code = '';
  try {
    code = String(JSON.parse(text)?.code ?? '');
  } catch {
    // 不是 JSON
  }
  if (res.status === 401) return new OllamaError('unpaired', t('這支手機的配對已經被移除，請在電腦的小幫手重新配對。'), code || 'not_paired');
  return new OllamaError('http', t('HTTP {p0}：{p1}', { p0: res.status, p1: text.slice(0, 200) }), code);
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
    engine: '',
    engineName: '',
    canLoad: true,
  };
}

function parseHardware(h: any): Hardware | null {
  if (!h || typeof h.memory_bytes !== 'number' || h.memory_bytes <= 0) return null;
  return {
    memoryBytes: h.memory_bytes,
    gpus: (Array.isArray(h.gpus) ? h.gpus : []).map((g: any) => ({ name: String(g?.name ?? ''), vramBytes: Number(g?.vram_bytes ?? 0) })),
    unified: !!h.unified,
  };
}

export function parseDownload(d: any): DownloadJob {
  const status = ['downloading', 'done', 'failed', 'cancelled'].includes(d?.status) ? d.status : 'failed';
  return {
    id: String(d?.id ?? ''),
    model: String(d?.model ?? ''),
    engine: String(d?.engine ?? ''),
    status,
    completed: Number(d?.completed ?? 0),
    total: Number(d?.total ?? 0),
    code: String(d?.code ?? ''),
    error: String(d?.error ?? ''),
    cancellable: !!d?.cancellable,
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
    // 只能開、不能關
    if (values.every((v) => v === true)) return { kind: 'always' };
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
  if (abort.cancelled()) return new OllamaError('cancelled', t('已取消'));
  if (abort.timedOut()) return new OllamaError('timeout', t('等了 {p0} 秒沒有回應', { p0: Math.round(timeoutMs / 1000) }));
  return new OllamaError('network', t('連不到主機：{p0}', { p0: e?.message ?? e }));
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** 第一次要先把模型載入顯示卡，大模型可能要 30～60 秒 */
export const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** 開始回答之後，超過這麼久沒有新字就當作斷線 */
export const IDLE_TIMEOUT_MS = 60_000;
/** 下載模型時，超過這麼久沒有新進度就當作斷線 */
const PULL_IDLE_MS = 300_000;

export type ClientOptions = {
  fetch?: FetchLike;
  /** 透過小幫手連線時，配對拿到的權杖 */
  token?: string;
  /** 一般請求、等第一個字、回答中途沒有新字的逾時（毫秒） */
  timeouts?: { request?: number; firstToken?: number; idle?: number };
};

export class OllamaClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly requestTimeout: number;
  private readonly firstTokenTimeout: number;
  private readonly idleTimeout: number;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? (expoFetch as unknown as FetchLike);
    this.headers = { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) };
    this.requestTimeout = options.timeouts?.request ?? DEFAULT_TIMEOUT_MS;
    this.firstTokenTimeout = options.timeouts?.firstToken ?? FIRST_TOKEN_TIMEOUT_MS;
    this.idleTimeout = options.timeouts?.idle ?? IDLE_TIMEOUT_MS;
  }

  private async json(path: string, body?: unknown, timeoutMs = this.requestTimeout, signal?: AbortSignal, method?: string): Promise<any> {
    const abort = makeAbort(timeoutMs, signal);
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: this.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw await httpError(res);
      if (res.status === 204) return null;
      return await res.json();
    } catch (e) {
      throw toOllamaError(e, abort, timeoutMs);
    } finally {
      abort.done();
    }
  }

  /** 問問看是不是 Local AI 小幫手；不是（或連不到）回 null */
  async helperHello(timeoutMs = this.requestTimeout, signal?: AbortSignal): Promise<HelperHello | null> {
    try {
      const data = await this.json('/helper/v1/hello', undefined, timeoutMs, signal);
      if (data?.app !== 'local-ai-helper' || typeof data.id !== 'string') return null;
      return { id: data.id, name: String(data.name ?? ''), version: String(data.version ?? ''), pairing: !!data.pairing };
    } catch (e) {
      if (e instanceof OllamaError && e.kind === 'cancelled') throw e;
      return null;
    }
  }

  /** 只確認連不連得到（不經過 AI 引擎，引擎忙的時候也馬上回）：小幫手問 hello，直接連 Ollama 問版本 */
  async ping(helper: boolean, timeoutMs = this.requestTimeout, signal?: AbortSignal): Promise<void> {
    await this.json(helper ? '/helper/v1/hello' : '/api/version', undefined, timeoutMs, signal);
  }

  /** 用電腦上顯示的配對碼換權杖 */
  async pair(code: string, deviceName: string): Promise<{ token: string; helperId: string; name: string }> {
    const data = await this.json('/helper/v1/pair', { code: code.replace(/\s+/g, ''), deviceName });
    if (typeof data?.token !== 'string') throw new OllamaError('server', t('小幫手沒有回傳權杖'));
    return { token: data.token, helperId: String(data.helper?.id ?? ''), name: String(data.helper?.name ?? '') };
  }

  /** 小幫手的資訊（能下載到哪個引擎、電腦配備） */
  async helperInfo(): Promise<HelperInfo> {
    const data = await this.json('/helper/v1/info');
    return {
      downloadEngines: (Array.isArray(data?.download_engines) ? data.download_engines : []).map(String),
      hardware: parseHardware(data?.hardware),
    };
  }

  /** 小幫手上的下載工作 */
  async downloads(): Promise<DownloadJob[]> {
    const data = await this.json('/helper/v1/downloads');
    return (data?.downloads ?? []).map(parseDownload);
  }

  /** 叫小幫手下載模型（在電腦上跑，手機關掉也會繼續）；engine 不給就用預設 */
  async startDownload(model: string, engine?: string): Promise<DownloadJob> {
    return parseDownload(await this.json('/helper/v1/downloads', { model, ...(engine ? { engine } : {}) }));
  }

  /** 取消下載中的工作；已經結束的從清單拿掉 */
  async stopDownload(id: string): Promise<void> {
    await this.json(`/helper/v1/downloads/${encodeURIComponent(id)}`, undefined, this.requestTimeout, undefined, 'DELETE');
  }

  /** 直接叫 Ollama 下載（沒有小幫手時）；各層進度加起來回報 */
  async pull(model: string, onProgress: (completed: number, total: number) => void, signal?: AbortSignal): Promise<void> {
    // 大模型下載完要驗證檔案，可能好幾分鐘沒有新進度
    const abort = makeAbort(PULL_IDLE_MS, signal);
    try {
      const res = await this.fetchImpl(this.baseUrl + '/api/pull', {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ model, stream: true }),
        signal: abort.signal,
      });
      if (!res.ok) throw await httpError(res);
      if (!res.body) throw new OllamaError('server', t('主機沒有回傳串流資料'));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const splitter = new NdjsonSplitter();
      const layers = new Map<string, { total: number; completed: number }>();
      let success = false;
      const handle = (obj: any) => {
        if (obj?.error) throw new OllamaError('server', String(obj.error), /file does not exist|not found/i.test(String(obj.error)) ? 'not_found' : '');
        if (obj?.digest && obj.total > 0) {
          layers.set(obj.digest, { total: Number(obj.total), completed: Number(obj.completed ?? 0) });
          let total = 0;
          let completed = 0;
          layers.forEach((l) => {
            total += l.total;
            completed += l.completed;
          });
          onProgress(completed, total);
        }
        if (obj?.status === 'success') success = true;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        abort.touch();
        if (value) splitter.push(decoder.decode(value, { stream: true })).forEach(handle);
      }
      splitter.push(decoder.decode()).forEach(handle);
      splitter.flush().forEach(handle);
      if (!success) throw new OllamaError('network', t('下載還沒完成連線就斷了'));
    } catch (e) {
      throw toOllamaError(e, abort, PULL_IDLE_MS);
    } finally {
      abort.done();
    }
  }

  /** 確認是不是 Ollama，並量回應時間 */
  async version(timeoutMs = this.requestTimeout, signal?: AbortSignal): Promise<{ version: string; latencyMs: number }> {
    const start = Date.now();
    const data = await this.json('/api/version', undefined, timeoutMs, signal);
    if (typeof data?.version !== 'string') throw new OllamaError('server', t('這個位址不是 Ollama'));
    return { version: data.version, latencyMs: Date.now() - start };
  }

  /** 列出可以聊天的模型（含能力），依名稱排序 */
  async listModels(): Promise<ModelInfo[]> {
    const tags = await this.json('/api/tags');
    // 透過小幫手時，每個模型多帶 engine、engine_name、can_load
    const extra = new Map<string, { engine: string; engineName: string; canLoad: boolean }>();
    for (const m of tags?.models ?? []) {
      extra.set(String(m.name), { engine: String(m.engine ?? ''), engineName: String(m.engine_name ?? ''), canLoad: m.can_load !== false });
    }
    const names = [...extra.keys()].filter((name) => !isHashName(name));
    const infos = await Promise.all(
      names.map(async (name) => {
        try {
          const info = parseModelInfo(name, await this.json('/api/show', { model: name }));
          return info && { ...info, ...extra.get(name)! };
        } catch {
          return null; // 查不到的模型就略過
        }
      })
    );
    return infos.filter((m): m is ModelInfo => m !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 目前已載入顯示卡的模型 */
  async loaded(timeoutMs = this.requestTimeout): Promise<LoadedModel[]> {
    const data = await this.json('/api/ps', undefined, timeoutMs);
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
        headers: this.headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw await httpError(res);
      if (!res.body) throw new OllamaError('server', t('主機沒有回傳串流資料'));

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
      if (!final) throw new OllamaError('network', t('回答還沒結束連線就斷了'));
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
