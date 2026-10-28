// 找 Ollama 主機：區網掃描、手動輸入位址的解析。主機一律不寫死在程式裡。

export const OLLAMA_PORT = 11434;

/** 私人網段（10/8、172.16/12、192.168/16）才掃，避免在 4G 之類的網路上亂掃 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = parseIPv4(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseIPv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** 同一個 /24 網段裡其他可能的主機位址（不含自己、.0、.255），依離自己的遠近排序，先掃附近的 */
export function subnetCandidates(ip: string): string[] {
  const parts = parseIPv4(ip);
  if (!parts || !isPrivateIPv4(ip)) return [];
  const [a, b, c, self] = parts;
  const hosts: number[] = [];
  for (let d = 1; d <= 254; d++) if (d !== self) hosts.push(d);
  hosts.sort((x, y) => Math.abs(x - self) - Math.abs(y - self) || x - y);
  return hosts.map((d) => `${a}.${b}.${c}.${d}`);
}

export function hostUrl(host: string, port = OLLAMA_PORT): string {
  return `http://${host}:${port}`;
}

/**
 * 解析使用者輸入的主機位址。可以輸入：
 * 192.168.1.5、192.168.1.5:11434、http://192.168.1.5:11434/、my-pc（Tailscale 名稱）、my-pc.tail1234.ts.net
 */
export function parseHostInput(input: string): { url: string; label: string } | { error: string } {
  const text = input.trim().replace(/\/+$/, '');
  if (!text) return { error: '請輸入主機位址' };
  const m = /^(?:(https?):\/\/)?([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(text);
  if (!m) return { error: '位址格式不對，例如 192.168.1.5 或 192.168.1.5:11434' };
  const scheme = (m[1] ?? 'http').toLowerCase();
  const host = m[2].toLowerCase();
  const port = m[3] ? Number(m[3]) : OLLAMA_PORT;
  if (port < 1 || port > 65535) return { error: '連接埠要在 1～65535 之間' };
  if (/^\d+(\.\d+)*$/.test(host) && !parseIPv4(host)) return { error: 'IP 位址格式不對' };
  return { url: `${scheme}://${host}:${port}`, label: port === OLLAMA_PORT ? host : `${host}:${port}` };
}

export type ScanOptions = {
  /** 同時問幾台 */
  concurrency?: number;
  onFound?: (url: string, version: string) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

/**
 * 依序問每個位址是不是 Ollama。probe 回傳版本字串代表找到，回 null 或丟錯代表沒有。
 * 回傳找到的位址（照候選順序）。
 */
export async function scanHosts(
  candidates: string[],
  probe: (url: string) => Promise<string | null>,
  options: ScanOptions = {}
): Promise<{ url: string; version: string }[]> {
  const { concurrency = 32, onFound, onProgress, signal } = options;
  const found: { index: number; url: string; version: string }[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < candidates.length && !signal?.aborted) {
      const index = next++;
      const url = candidates[index];
      try {
        const version = await probe(url);
        if (version && !signal?.aborted) {
          found.push({ index, url, version });
          onFound?.(url, version);
        }
      } catch {
        // 沒回應就是沒有
      }
      done++;
      onProgress?.(done, candidates.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return found.sort((a, b) => a.index - b.index).map(({ url, version }) => ({ url, version }));
}
