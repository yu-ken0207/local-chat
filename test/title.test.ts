import { fmtWhen } from '../src/lib/format';
import { cleanTitle, fallbackTitle } from '../src/lib/title';

test.each([
  ['「午餐推薦」', '午餐推薦'],
  ['標題：**台南牛肉湯**。', '台南牛肉湯'],
  ['# Docker 安裝\n說明…', 'Docker 安裝'],
  ['<think>想一下</think>\n照片中的貓', '照片中的貓'],
  ['這是一個非常非常非常非常長的標題超過二十個字一定會被切掉', '這是一個非常非常非常非常長的標題超過二十'],
  ['  \n  ', ''],
])('整理模型取的標題：%s', (raw, expected) => {
  expect(cleanTitle(raw)).toBe(expected);
});

test('備用標題：第一句話的開頭', () => {
  expect(fallbackTitle('  今天   天氣如何 ')).toBe('今天 天氣如何');
  expect(fallbackTitle('一二三四五六七八九十一二三四五六七八')).toBe('一二三四五六七八九十一二三四五六…');
});

test('對話清單的時間', () => {
  const now = new Date(2026, 9, 28, 19, 5).getTime();
  expect(fmtWhen(new Date(2026, 9, 28, 8, 3).getTime(), now)).toBe('08:03');
  expect(fmtWhen(new Date(2026, 9, 27, 23, 59).getTime(), now)).toBe('昨天');
  expect(fmtWhen(new Date(2026, 0, 2).getTime(), now)).toBe('1/2');
  expect(fmtWhen(new Date(2025, 11, 31).getTime(), now)).toBe('2025/12/31');
});
