import { isPrivateIPv4, parseHostInput, scanHosts, subnetCandidates } from '../src/lib/discovery';

describe('isPrivateIPv4', () => {
  test.each([
    ['192.168.50.171', true],
    ['10.2.238.157', true],
    ['172.16.0.1', true],
    ['172.31.255.1', true],
    ['172.32.0.1', false],
    ['100.100.50.123', false], // Tailscale 位址不在私人網段，不掃
    ['8.8.8.8', false],
    ['256.1.1.1', false],
    ['abc', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });
});

describe('subnetCandidates', () => {
  test('同網段 253 個位址，不含自己、.0、.255，從附近開始', () => {
    const list = subnetCandidates('192.168.1.10');
    expect(list).toHaveLength(253);
    expect(list).not.toContain('192.168.1.10');
    expect(list).not.toContain('192.168.1.0');
    expect(list).not.toContain('192.168.1.255');
    expect(list.slice(0, 4)).toEqual(['192.168.1.9', '192.168.1.11', '192.168.1.8', '192.168.1.12']);
  });

  test('不是私人網段就不掃', () => {
    expect(subnetCandidates('100.100.50.123')).toEqual([]);
    expect(subnetCandidates('')).toEqual([]);
  });
});

describe('parseHostInput', () => {
  test.each([
    ['192.168.1.5', 'http://192.168.1.5:11434', '192.168.1.5'],
    ['  192.168.1.5:11434 ', 'http://192.168.1.5:11434', '192.168.1.5'],
    ['http://192.168.1.5:8080/', 'http://192.168.1.5:8080', '192.168.1.5:8080'],
    ['MY-PC', 'http://my-pc:11434', 'my-pc'],
    ['my-pc.tail1234.ts.net', 'http://my-pc.tail1234.ts.net:11434', 'my-pc.tail1234.ts.net'],
    ['https://ollama.example.com:443', 'https://ollama.example.com:443', 'ollama.example.com:443'],
  ])('%s', (input, url, label) => {
    expect(parseHostInput(input)).toEqual({ url, label });
  });

  test.each([
    ['', '請輸入位址'],
    ['192.168.1.5:99999', '連接埠'],
    ['192.168.1', 'IP 位址格式不對'],
    ['300.1.1.1', 'IP 位址格式不對'],
    ['http://a b', '位址格式不對'],
    ['ftp://x', '位址格式不對'],
  ])('錯誤輸入 %s', (input, message) => {
    const r = parseHostInput(input);
    expect('error' in r && r.error).toContain(message);
  });
});

describe('scanHosts', () => {
  test('回傳找到的主機（照候選順序），回報進度', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'];
    const progress: number[] = [];
    const found: string[] = [];
    const result = await scanHosts(
      candidates,
      async (url) => (url === 'd' || url === 'b' ? `v-${url}` : null),
      { concurrency: 2, onProgress: (done) => progress.push(done), onFound: (url) => found.push(url) }
    );
    expect(result).toEqual([
      { url: 'b', version: 'v-b' },
      { url: 'd', version: 'v-d' },
    ]);
    expect(found.sort()).toEqual(['b', 'd']);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });

  test('同時問的數量不超過 concurrency，丟錯當作沒有', async () => {
    let running = 0;
    let peak = 0;
    const result = await scanHosts(
      Array.from({ length: 20 }, (_, i) => String(i)),
      async (url) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        if (url === '3') throw new Error('timeout');
        return url === '7' ? '0.40.0' : null;
      },
      { concurrency: 4 }
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(result).toEqual([{ url: '7', version: '0.40.0' }]);
  });

  test('取消之後不再問新的位址', async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    await scanHosts(
      ['a', 'b', 'c', 'd'],
      async (url) => {
        asked.push(url);
        if (url === 'a') controller.abort();
        return null;
      },
      { concurrency: 1, signal: controller.signal }
    );
    expect(asked).toEqual(['a']);
  });
});
