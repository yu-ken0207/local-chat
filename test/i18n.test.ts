/**
 * @jest-environment node
 */
/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { getLanguage, setLanguage, t } from '../src/i18n';
import { en } from '../src/i18n/en';

// 檢查翻譯是否完整：程式裡的中文都要經過 t()，每個 t() 的原文都要有英文

const ROOT = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'i18n' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

const FILES = [join(ROOT, 'App.tsx'), ...sourceFiles(join(ROOT, 'src'))];

/** 去掉註解（保留字串內容），也去掉標了 i18n-ignore 的行 */
function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.includes('i18n-ignore'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const T_CALL = /(?<![\w.$])t\(\s*'((?:[^'\\]|\\.)*)'/g;

function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function keysIn(src: string): string[] {
  return [...src.matchAll(T_CALL)].map((m) => unescape(m[1]));
}

test('程式裡的中文都經過 t() 翻譯', () => {
  const leftovers: string[] = [];
  for (const file of FILES) {
    const code = stripComments(readFileSync(file, 'utf8')).replace(T_CALL, "t(''");
    code.split('\n').forEach((line, i) => {
      if (/[一-鿿]/.test(line)) leftovers.push(`${file.replace(ROOT, '')}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(leftovers).toEqual([]);
});

test('每個 t() 的原文都有英文翻譯，參數名稱一致', () => {
  const missing: string[] = [];
  const badParams: string[] = [];
  const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const file of FILES) {
    for (const key of keysIn(readFileSync(file, 'utf8'))) {
      if (!(key in en)) missing.push(key);
      else if (params(key) !== params(en[key])) badParams.push(`${key} → ${en[key]}`);
    }
  }
  expect([...new Set(missing)]).toEqual([]);
  expect(badParams).toEqual([]);
});

test('英文翻譯裡不能還有中文', () => {
  const allowed = new Set(['繁體中文']);
  const leftovers = Object.entries(en).filter(([, v]) => /[一-鿿]/.test(v) && !allowed.has(v));
  expect(leftovers).toEqual([]);
});

test('切換語言、帶參數', () => {
  const before = getLanguage();
  try {
    setLanguage('en');
    expect(t('已刪除 {p0} 段對話', { p0: 3 })).toBe(en['已刪除 {p0} 段對話'].replace('{p0}', '3'));
    expect(t('完全沒有的字')).toBe('完全沒有的字');
    setLanguage('zh-Hant');
    expect(t('已刪除 {p0} 段對話', { p0: 3 })).toBe('已刪除 3 段對話');
  } finally {
    setLanguage(before);
  }
});
