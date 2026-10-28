import { contextLevel, fmtBytes, fmtElapsed, fmtTokPerSec } from '../src/lib/format';
import { fitSize } from '../src/lib/photos';

test('秒數格式跟 Codex 一樣', () => {
  expect(fmtElapsed(0)).toBe('0s');
  expect(fmtElapsed(59.9)).toBe('59s');
  expect(fmtElapsed(60)).toBe('1m 00s');
  expect(fmtElapsed(3 * 60 + 5)).toBe('3m 05s');
  expect(fmtElapsed(3600 + 61)).toBe('1h 01m 01s');
  expect(fmtElapsed(-3)).toBe('0s');
});

test('生成速度', () => {
  expect(fmtTokPerSec(202, 1_000_000_000)).toBe('202.0 tok/s');
  expect(fmtTokPerSec(2, 41_805_000)).toBe('47.8 tok/s');
  expect(fmtTokPerSec(0, 1e9)).toBe('');
  expect(fmtTokPerSec(10, 0)).toBe('');
});

test('容量', () => {
  expect(fmtBytes(8_060_739_255)).toBe('8.1 GB');
  expect(fmtBytes(250_000_000)).toBe('250 MB');
});

test('上下文用量：80% 提醒、滿了警告、不知道上限就不提醒', () => {
  expect(contextLevel(1000, 8192)).toBe('ok');
  expect(contextLevel(6600, 8192)).toBe('near');
  expect(contextLevel(8192, 8192)).toBe('full');
  expect(contextLevel(99999, null)).toBe('ok');
});

test('照片縮放：長邊縮到 1024，比例不變；小照片不動', () => {
  expect(fitSize(4032, 3024)).toEqual({ width: 1024, height: 768 });
  expect(fitSize(3024, 4032)).toEqual({ width: 768, height: 1024 });
  expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  expect(fitSize(0, 0)).toEqual({ width: 0, height: 0 });
});
