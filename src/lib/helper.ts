import { t } from '../i18n';
import { OllamaError } from './ollama';

// Local AI 小幫手：裝在電腦上，手機配對後透過它用電腦上的模型（Ollama、LM Studio…）。

export const HELPER_PORT = 11480;

/** 小幫手 QR code 的內容 */
export type PairingPayload = { id: string; name: string; port: number; code: string; ips: string[] };

/** 解析 QR code：localai://pair?v=1&id=...&name=...&port=11480&code=123456&ip=...&ip=... 不是就回 null */
export function parsePairingPayload(text: string): PairingPayload | null {
  const m = /^localai:\/\/pair\?(.*)$/i.exec(text.trim());
  if (!m) return null;
  const params = new Map<string, string[]>();
  for (const part of m[1].split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    let value: string;
    try {
      value = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      return null;
    }
    params.set(k, [...(params.get(k) ?? []), value]);
  }
  const one = (k: string) => params.get(k)?.[0] ?? '';
  const port = Number(one('port') || HELPER_PORT);
  const code = one('code').replace(/\s+/g, '');
  const ips = (params.get('ip') ?? []).filter((ip) => /^[0-9a-z.:-]+$/i.test(ip));
  if (!one('id') || !/^\d{6}$/.test(code) || ips.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { id: one('id'), name: one('name'), port, code, ips };
}

/** 配對失敗時給使用者看的話 */
export function pairErrorMessage(e: unknown): string {
  const code = e instanceof OllamaError ? e.code : '';
  if (code === 'bad_code') return t('配對碼不對。請再看一次電腦畫面上的 6 位數字。');
  if (code === 'not_pairing') return t('電腦上的配對已經結束了。請在小幫手按「配對新手機」再試一次。');
  if (code === 'too_many_attempts') return t('打錯太多次，電腦上的配對已經關掉。請在小幫手重新按「配對新手機」。');
  if (e instanceof OllamaError && (e.kind === 'network' || e.kind === 'timeout')) return t('連不到這台電腦。請確認手機和電腦連同一個 Wi-Fi，而且小幫手開著。');
  return t('配對沒有成功：{p0}', { p0: e instanceof Error ? e.message : String(e) });
}
