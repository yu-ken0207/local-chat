// 把 Ollama 的模型名稱（gemma4:12b、gpt-oss:20b、hf.co/xxx/Name:Q4_0）變成一般人好讀的名字。原始名稱放在詳細資訊裡。

const KNOWN: Record<string, string> = {
  'gpt-oss': 'GPT-OSS',
  llava: 'LLaVA',
  'llama3.2-vision': 'Llama 3.2 Vision',
  phi4: 'Phi-4',
  'phi4-mini': 'Phi-4 Mini',
  deepseek: 'DeepSeek',
  'deepseek-r1': 'DeepSeek R1',
  minicpm: 'MiniCPM',
};

function prettyBase(base: string): string {
  const lower = base.toLowerCase();
  if (KNOWN[lower]) return KNOWN[lower];
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((word, i) => {
      // 單字結尾的版本號分開：gemma4 → Gemma 4、llama3.2 → Llama 3.2（第一個字才分，qwen3-vl 的 vl 不動）
      const m = i === 0 ? /^([a-z]+)(\d+(?:\.\d+)?)$/i.exec(word) : null;
      if (m) return `${cap(m[1])} ${m[2]}`;
      if (/^[a-z]{1,3}$/i.test(word) && i > 0) return word.toUpperCase(); // vl、it、r1 這類縮寫
      if (/^\d+(\.\d+)?[a-z]$/i.test(word)) return word.toUpperCase(); // 24b → 24B
      return cap(word);
    })
    .join(' ');
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** 好讀的模型名稱，例如 gemma4:12b → Gemma 4 · 12B；latest 不顯示 */
export function friendlyModelName(name: string): string {
  const [path, tag = ''] = name.split(':');
  const base = path.split('/').at(-1) ?? path;
  const pretty = prettyBase(base);
  const t = tag.toLowerCase();
  if (!t || t === 'latest') return pretty;
  // 12b、e4b、4b、1.5b → 大寫；q4_0 這類量化標記也大寫
  return `${pretty} · ${tag.toUpperCase()}`;
}

/** 思考等級的白話說法 */
export function friendlyLevel(level: string): string {
  return ({ low: '快速', medium: '平衡', high: '仔細' } as Record<string, string>)[level] ?? level;
}
