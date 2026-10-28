/// <reference types="node" />
import http from 'http';
import https from 'https';

import type { FetchLike } from '../../src/lib/ollama';

/**
 * jest-expo 會把全域 fetch 換成假的，打真主機的測試改用 Node 的 http 模組。
 * 回應的 body 提供 getReader()，跟 expo/fetch 一樣可以一段一段讀。
 */
export const nodeFetch: FetchLike = (url, init) =>
  new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
    if (init.signal?.aborted) return reject(abortError());
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: init.method, headers: init.headers }, (res) => {
      const iterator = res[Symbol.asyncIterator]();
      let consumed = false;
      const readAll = async () => {
        consumed = true;
        const parts: Buffer[] = [];
        for await (const chunk of res) parts.push(chunk as Buffer);
        return Buffer.concat(parts).toString('utf8');
      };
      resolve({
        ok: (res.statusCode ?? 0) < 400,
        status: res.statusCode ?? 0,
        text: readAll,
        json: async () => JSON.parse(await readAll()),
        body: {
          getReader: () => ({
            read: async () => {
              if (consumed) throw new Error('body already used');
              if (init.signal?.aborted) throw abortError();
              const { done, value } = await iterator.next();
              return done ? { done: true } : { done: false, value: new Uint8Array(value as Buffer) };
            },
          }),
        },
      });
    });
    init.signal?.addEventListener('abort', () => req.destroy(abortError()));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
