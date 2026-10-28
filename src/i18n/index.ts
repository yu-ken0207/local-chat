import { en } from './en';

export type Lang = 'zh-Hant' | 'en';

let current: Lang = 'zh-Hant';

/** 切換畫面語言（由控制器依設定呼叫） */
export function setLanguage(lang: Lang): void {
  current = lang;
}

export function getLanguage(): Lang {
  return current;
}

/**
 * 翻譯：用繁體中文原文當 key，英文在 en.ts。參數寫成 {name}。
 * 找不到英文翻譯時顯示中文（測試會檢查每個 key 都有翻譯）。
 */
export function t(text: string, params?: Record<string, string | number>): string {
  const s = current === 'en' ? (en[text] ?? text) : text;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
}
