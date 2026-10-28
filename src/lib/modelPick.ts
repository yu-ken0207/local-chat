import type { LoadedModel, ModelInfo } from './ollama';

/**
 * 連上電腦後自動選一個模型，讓使用者不用先設定就能開始聊。
 * 優先順序：已經載入顯示卡（回答最快）且看得懂圖片 > 已載入 > 看得懂圖片 > 清單第一個。
 */
export function pickDefaultModel(list: ModelInfo[], loaded: LoadedModel[]): string | null {
  const isLoaded = (m: ModelInfo) => loaded.some((l) => l.name === m.name);
  return (
    list.find((m) => isLoaded(m) && m.vision)?.name ??
    list.find(isLoaded)?.name ??
    list.find((m) => m.vision)?.name ??
    list[0]?.name ??
    null
  );
}
