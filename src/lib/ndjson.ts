import { t } from '../i18n';

// Ollama 串流是一行一個 JSON（NDJSON）。網路送來的片段可能把一行切成兩半，這裡負責接起來再解析。
export class NdjsonSplitter {
  private buffer = '';

  push(text: string): unknown[] {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map((line) => line.trim()).filter(Boolean).map(parseLine);
  }

  flush(): unknown[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [parseLine(rest)] : [];
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(t('串流資料格式錯誤：{p0}', { p0: line.slice(0, 80) }));
  }
}
