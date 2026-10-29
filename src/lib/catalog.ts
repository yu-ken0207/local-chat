import { t } from '../i18n';
import type { Hardware, ModelInfo } from './ollama';

// 推薦下載的模型。名稱與大小都對過 Ollama 官方倉庫與 LM Studio 目錄（2026-10）。
// 由好到小排：推薦時挑第一個這台電腦跑得順的。

export type CatalogEntry = {
  /** Ollama 的名稱 */
  ollama: string;
  /** LM Studio 目錄裡的名稱 */
  lmstudio: string;
  /** 下載大小（GB，Ollama 版；LM Studio 版差不多） */
  sizeGB: number;
  vision: boolean;
  think: boolean;
  blurb: () => string;
};

export const CATALOG: CatalogEntry[] = [
  { ollama: 'gemma4:31b', lmstudio: 'google/gemma-4-31b', sizeGB: 20.4, vision: true, think: true, blurb: () => t('最聰明，要有很好的顯示卡') },
  { ollama: 'gemma4:26b', lmstudio: 'google/gemma-4-26b-a4b', sizeGB: 18.7, vision: true, think: true, blurb: () => t('接近最聰明，回答比較快') },
  { ollama: 'gpt-oss:20b', lmstudio: 'openai/gpt-oss-20b', sizeGB: 13.8, vision: false, think: true, blurb: () => t('擅長推理、數學與寫程式') },
  { ollama: 'gemma4:12b', lmstudio: 'google/gemma-4-12b', sizeGB: 8.0, vision: true, think: true, blurb: () => t('聰明又不會太大，適合大部分顯示卡') },
  { ollama: 'gemma4:e4b', lmstudio: 'google/gemma-4-e4b', sizeGB: 6.6, vision: true, think: true, blurb: () => t('小而快，一般電腦就能跑') },
  { ollama: 'qwen3:8b', lmstudio: 'qwen/qwen3-8b', sizeGB: 5.2, vision: false, think: true, blurb: () => t('中文流暢，不看圖') },
  { ollama: 'gemma4:e2b', lmstudio: 'google/gemma-4-e2b', sizeGB: 4.6, vision: true, think: true, blurb: () => t('很輕巧，筆電也能跑') },
  { ollama: 'qwen3:4b', lmstudio: 'qwen/qwen3-4b', sizeGB: 2.5, vision: false, think: true, blurb: () => t('最小，沒有顯示卡也能跑') },
];

/**
 * 跑不跑得動：
 * great 整個放得進顯示卡（或共用記憶體），回答快；ok 沒有顯示卡但模型夠小；
 * slow 要分一部分給 CPU，回答慢；too-big 記憶體不夠；unknown 不知道電腦配備
 */
export type Fit = 'great' | 'ok' | 'slow' | 'too-big' | 'unknown';

const GB = 1e9;

export function fitFor(sizeGB: number, hw: Hardware | null): Fit {
  if (!hw || hw.memoryBytes <= 0) return 'unknown';
  // 執行時除了模型本身，還要放對話內容（上下文）
  const need = sizeGB * 1.2 + 1;
  const ram = hw.memoryBytes / GB;
  if (hw.unified) return need <= ram * 0.7 ? 'great' : 'too-big';
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramBytes / GB));
  if (vram > 0) {
    if (need <= vram) return 'great';
    return need <= vram + ram * 0.5 ? 'slow' : 'too-big';
  }
  // 沒有顯示卡：只有小模型回答得夠快
  if (need <= Math.min(6.6, ram * 0.5)) return 'ok';
  return need <= ram * 0.6 ? 'slow' : 'too-big';
}

export type Suggestion = { entry: CatalogEntry; name: string; fit: Fit; installed: boolean };

/** 這台電腦用這個引擎下載時的推薦清單（名稱換成引擎認得的） */
export function suggestions(hw: Hardware | null, engine: string, models: ModelInfo[]): Suggestion[] {
  const have = new Set(models.map((m) => m.name.replace(/@[\w:.-]+$/, '').replace(/:latest$/, '')));
  return CATALOG.map((entry) => {
    const name = engine === 'lmstudio' ? entry.lmstudio : entry.ollama;
    return { entry, name, fit: fitFor(entry.sizeGB, hw), installed: have.has(name) };
  });
}

/** 最推薦的一個：跑得順的裡面最好的；不知道配備時推薦中等大小的 */
export function bestPick(list: Suggestion[]): Suggestion | null {
  return (
    list.find((s) => s.fit === 'great') ??
    list.find((s) => s.fit === 'ok') ??
    list.find((s) => s.fit === 'unknown' && s.entry.ollama === 'gemma4:e4b') ??
    null
  );
}

/** 電腦配備的白話說明，例如「NVIDIA GeForce RTX 5070（12 GB）· 記憶體 32 GB」 */
export function describeHardware(hw: Hardware | null): string {
  if (!hw) return '';
  const ram = t('記憶體 {p0} GB', { p0: Math.round(hw.memoryBytes / GB) });
  if (hw.unified) return `${hw.gpus[0]?.name ?? ''} · ${t('{p0}（跟顯示卡共用）', { p0: ram })}`.replace(/^ · /, '');
  const gpus = hw.gpus.filter((g) => g.vramBytes > 0).map((g) => `${g.name.replace(/^NVIDIA /, '')} ${Math.round(g.vramBytes / 2 ** 30)} GB`);
  return [...gpus, ram].join(' · ');
}
