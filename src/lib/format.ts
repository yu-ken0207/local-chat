import { t } from '../i18n';

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

/** 位元組換成 GB／MB／KB */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
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

/** 對話清單的時間：今天只寫時間，昨天、今年寫月日，其他寫年月日 */
export function fmtWhen(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const p = (x: number) => String(x).padStart(2, '0');
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, n)) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (sameDay(d, yesterday)) return t('昨天');
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const ZH_WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']; // i18n-ignore：星期名稱，英文另外一組
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * 行程時間的白話：中文「11/4（週三）15:00–16:00」，英文「Wed 11/4 15:00–16:00」；整天的寫「11/20（週五）整天」。
 * 跨天時結束也寫日期。
 */
export function fmtEventTime(start: Date, end: Date | null, allDay: boolean, lang: 'zh-Hant' | 'en'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = (d: Date) => {
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    // 不用 Intl：iPhone 的 zh-TW 會給簡體的「周五」
    const wd = (lang === 'en' ? EN_WEEKDAYS : ZH_WEEKDAYS)[d.getDay()];
    return lang === 'en' ? `${wd} ${md}` : `${md}\uff08${wd}\uff09`;
  };
  const time = (d: Date) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  // 中文的括號後面不空格；英文要空格
  const sep = lang === 'en' ? ' ' : '';
  // 整天的行程明寫「整天」，不然只看到日期，看不出是整天還是忘了寫時間
  if (allDay) {
    const days = end && end.toDateString() !== start.toDateString() ? `${day(start)}–${day(end)}` : day(start);
    return lang === 'en' ? `${days}, all day` : `${days}整天`; // i18n-ignore：跟著 lang 參數切換，不走 t()
  }
  if (!end) return `${day(start)}${sep}${time(start)}`;
  const sameDay = end.toDateString() === start.toDateString();
  return `${day(start)}${sep}${time(start)}–${sameDay ? '' : day(end) + sep}${time(end)}`;
}
