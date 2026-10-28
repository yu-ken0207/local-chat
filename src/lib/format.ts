// 秒數寫法照 Codex：59s、1m 05s、1h 02m 03s
export function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
}

/** 生成速度，例如 42.3 tok/s；沒有資料時回空字串 */
export function fmtTokPerSec(evalCount: number, evalDurationNs: number): string {
  if (!(evalCount > 0) || !(evalDurationNs > 0)) return '';
  return `${(evalCount / (evalDurationNs / 1e9)).toFixed(1)} tok/s`;
}

/** 位元組換成 GB／MB */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

export type ContextLevel = 'ok' | 'near' | 'full';

/** 上下文用量：超過 80% 提醒、到 100% 表示前面的內容已經會被截掉 */
export function contextLevel(usedTokens: number, limit: number | null): ContextLevel {
  if (!limit || limit <= 0) return 'ok';
  const ratio = usedTokens / limit;
  if (ratio >= 1) return 'full';
  if (ratio >= 0.8) return 'near';
  return 'ok';
}
