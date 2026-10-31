import { getLanguage, t } from '../i18n';

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

/** 大數字縮短：中文「15.2 萬」、英文「15.2K」；中文一萬、英文一千以下照寫 */
export function fmtCount(n: number): string {
  const x = Math.max(0, Math.round(n));
  const short = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ''));
  if (getLanguage() === 'en') {
    if (x < 1000) return String(x);
    return x < 1e6 ? `${short(x / 1e3)}K` : `${short(x / 1e6)}M`;
  }
  if (x < 1e4) return x.toLocaleString('en-US');
  return x < 1e8 ? `${short(x / 1e4)} 萬` : `${short(x / 1e8)} 億`; // i18n-ignore：中文的數字單位，英文在上面另外寫
}

/** 上下文大小的短寫：1,203 寫 1.2K、32,768 寫 32K（以 1024 算一 K，跟大家說的 8K、32K、128K 一樣） */
export function fmtK(n: number): string {
  const x = Math.max(0, Math.round(n));
  if (x < 1000) return String(x);
  const k = x / 1024;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
}

/** 估出來的 token 數：一千以上取到百位、一百以上取到十位（看起來才不會像精確值） */
export function fmtRough(n: number): string {
  const x = Math.max(0, n);
  const r = x >= 1000 ? Math.round(x / 100) * 100 : x >= 100 ? Math.round(x / 10) * 10 : Math.round(x);
  return r.toLocaleString('en-US');
}

/** 載入的模型多久後卸載（Ollama 的 expires_at）；設成一直載入的（年份很遠）寫「一直載入」 */
export function fmtUnload(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms > 365 * 24 * 60 * 60 * 1000) return t('一直載入');
  if (ms < 60 * 1000) return t('快要卸載了');
  const min = Math.round(ms / 60000);
  if (min < 60) return t('{n} 分鐘後卸載', { n: min });
  return t('{n} 小時後卸載', { n: Math.round(min / 60) });
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
