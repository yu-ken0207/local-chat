import type { FetchLike } from '../../src/lib/ollama';

type Route = (body: any) => { status?: number; json?: unknown; text?: string; chunks?: (string | Uint8Array)[]; hang?: boolean };

/**
 * 假的 fetch：依路徑回應。chunks 會一段一段從串流送出；hang 代表一直不回（用來測逾時與取消）。
 * calls 記錄每次請求，方便檢查送出的內容。
 */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, body });
    const route = routes[path];
    if (!route) throw new TypeError('Network request failed');
    const r = route(body);
    const waitForAbort = () =>
      new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) fail();
        init.signal?.addEventListener('abort', fail);
      });
    if (r.hang && !r.chunks) return waitForAbort();
    const encoder = new TextEncoder();
    const chunks = (r.chunks ?? []).map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
    let i = 0;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      text: async () => r.text ?? JSON.stringify(r.json ?? ''),
      json: async () => r.json,
      body: {
        getReader: () => ({
          read: async () => {
            if (init.signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            if (i < chunks.length) return { done: false, value: chunks[i++] };
            if (r.hang) return waitForAbort();
            return { done: true };
          },
        }),
      },
    };
  };
  return { fetch, calls };
}

/** 把一個字串的 UTF-8 位元組切成兩半（用來測中文字被切斷） */
export function splitBytes(text: string, at: number): [Uint8Array, Uint8Array] {
  const bytes = new TextEncoder().encode(text);
  return [bytes.slice(0, at), bytes.slice(at)];
}
