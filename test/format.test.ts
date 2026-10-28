import { fmtElapsed } from '../src/lib/format';

test('秒數格式跟 Codex 一樣', () => {
  expect(fmtElapsed(0)).toBe('0s');
  expect(fmtElapsed(59.9)).toBe('59s');
  expect(fmtElapsed(60)).toBe('1m 00s');
  expect(fmtElapsed(3 * 60 + 5)).toBe('3m 05s');
  expect(fmtElapsed(3600 + 61)).toBe('1h 01m 01s');
  expect(fmtElapsed(-3)).toBe('0s');
});
