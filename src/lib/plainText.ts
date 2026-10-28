import { t } from '../i18n';

/** 把 Markdown 變成適合朗讀的純文字：程式碼區塊不念、去掉符號、連結只念文字 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, t('（程式碼）'))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
