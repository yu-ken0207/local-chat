// 對話標題：整理模型取的標題、取不到時用第一句話

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
