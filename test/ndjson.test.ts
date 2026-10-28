import { NdjsonSplitter } from '../src/lib/ndjson';

describe('NdjsonSplitter', () => {
  test('一段裡有好幾行', () => {
    const s = new NdjsonSplitter();
    expect(s.push('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('一行被切成兩段，要接起來', () => {
    const s = new NdjsonSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b"')).toEqual([{ a: 1 }]);
    expect(s.push(':2}\n')).toEqual([{ b: 2 }]);
  });

  test('空行略過、最後沒換行的那行在 flush 時送出', () => {
    const s = new NdjsonSplitter();
    expect(s.push('\n\n{"a":1}\n  \n{"a":2}')).toEqual([{ a: 1 }]);
    expect(s.flush()).toEqual([{ a: 2 }]);
    expect(s.flush()).toEqual([]);
  });

  test('格式錯誤時丟出看得懂的錯誤', () => {
    const s = new NdjsonSplitter();
    expect(() => s.push('not json\n')).toThrow('串流資料格式錯誤');
  });
});
