import { t } from '../i18n';
import type { Message, Session } from '../store/repo';

/** 時間寫成 2026-10-28 19:05 */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把一段對話匯出成 Markdown（照片只標張數，不放圖） */
export function exportMarkdown(session: Session, messages: Message[], options: { hostLabel: string; now: number }): string {
  const lines: string[] = [`# ${session.title || t('對話')}`, ''];
  if (session.model) lines.push(t('- 模型：{model}', { model: [options.hostLabel, session.model].filter(Boolean).join(' · ') }));
  if (session.systemPrompt.trim()) lines.push(t('- 自訂指示：{text}', { text: session.systemPrompt.trim().replace(/\n+/g, ' ') }));
  lines.push(t('- 匯出時間：{time}', { time: fmtDateTime(options.now) }), '', '---', '');
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(t('**你**：{text}', { text: m.content }));
      if (m.attachments.length > 0) lines.push(t('（附 {n} 張照片）', { n: m.attachments.length }));
    } else if (m.role === 'assistant') {
      if (!m.content.trim()) continue;
      lines.push(m.model ? t('**AI**（{model}）：', { model: m.model }) : t('**AI**：'), '', m.content.trim());
    } else {
      lines.push(`> ${m.content}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** 整理模型取的標題：去掉引號、井號、粗體符號，只留第一行，最多 20 字 */
export function cleanTitle(raw: string): string {
  const first = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? '';
  return [...first.replace(/^(標題|title)\s*[:：]\s*/i, '').replace(/[#*`"'“”‘’「」『』《》【】]/g, '').replace(/[。．.!！]+$/, '').trim()] // i18n-ignore：比對模型可能回的「標題：」與各種引號
    .slice(0, 20)
    .join('');
}

/** 模型取不到標題時，用第一句話的開頭 */
export function fallbackTitle(firstUserText: string): string {
  const t = firstUserText.replace(/\s+/g, ' ').trim();
  return [...t].length > 16 ? [...t].slice(0, 16).join('') + '…' : t;
}
