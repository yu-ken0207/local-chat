import type { Message } from '../store/repo';
import type { ChatMessage } from './ollama';
import { t } from '../i18n';

/** 系統提示詞：請 AI 用 App 的語言回答 */
export const DEFAULT_SYSTEM_PROMPT = '請用繁體中文（台灣用語）回答。'; // i18n-ignore：給 AI 的指示，不跟著畫面語言
export const REPLY_PROMPTS = { 'zh-Hant': DEFAULT_SYSTEM_PROMPT, en: 'Please reply in English.' } as const;
/** 只附照片沒打字時，代替使用者問的問題 */
export const defaultImageQuestion = () => t('這張照片裡有什麼？');

const UNDONE = 'The user pressed Undo afterwards, so this was reversed and no longer exists.';
/** 工具結果加註「使用者後來按了復原」 */
function withUndone(content: string): string {
  try {
    return JSON.stringify({ ...JSON.parse(content), undone: UNDONE });
  } catch {
    return `${content} (${UNDONE})`;
  }
}

/**
 * 把存起來的對話整理成要送給 Ollama 的訊息。
 * - 錯誤、提示這類訊息不送
 * - 模型看不懂圖時拿掉照片，並回報拿掉幾張（畫面要提示使用者）
 * - 思考過程不送回去，只送回答
 * - 叫過的工具與工具結果要送回去，模型才知道做了什麼
 */
export function buildChatMessages(
  messages: Message[],
  options: { vision: boolean; systemPrompt?: string }
): { messages: ChatMessage[]; droppedImages: number } {
  const out: ChatMessage[] = [{ role: 'system', content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT }];
  let droppedImages = 0;
  const toolMessage = (m: Message, undone = false): ChatMessage => ({ role: 'tool', content: undone ? withUndone(m.content) : m.content, ...(m.toolName ? { tool_name: m.toolName } : {}), ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) });
  const sent = new Set<Message>();
  for (const [i, m] of messages.entries()) {
    if (sent.has(m)) continue;
    if (m.role === 'user') {
      const images = m.attachments.map((a) => a.base64);
      if (images.length > 0 && !options.vision) droppedImages += images.length;
      out.push({
        role: 'user',
        content: m.content,
        ...(images.length > 0 && options.vision ? { images } : {}),
      });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      // 叫過工具的回答：連同叫了什麼一起送回去（工具結果在後面的 tool 訊息）
      out.push({ role: 'assistant', content: m.content, tool_calls: m.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })) });
      // 結果照叫的順序排（使用者可能先按第二張卡、清單卡取消勾選的會先記下來）：
      // 有些模型只看順序對結果，順序亂了會把沒做的說成做了
      const end = messages.findIndex((x, j) => j > i && (x.role === 'user' || x.role === 'assistant'));
      const results = messages.slice(i + 1, end < 0 ? undefined : end).filter((x) => x.role === 'tool');
      const order = (x: Message) => {
        const k = m.toolCalls!.findIndex((c) => c.id === x.toolCallId);
        return k < 0 ? m.toolCalls!.length : k;
      };
      for (const r of [...results].sort((a, b) => order(a) - order(b))) {
        // 做了又按「復原」的：照實告訴模型，不然它以為行程還在
        out.push(toolMessage(r, m.actions?.find((a) => a.callId === r.toolCallId)?.status === 'undone'));
        sent.add(r);
      }
    } else if (m.role === 'assistant' && m.content.trim()) {
      out.push({ role: 'assistant', content: m.content });
    } else if (m.role === 'tool') {
      out.push(toolMessage(m));
    }
  }
  return { messages: out, droppedImages };
}

/** 對話裡一共有幾張照片 */
export function countImages(messages: Message[]): number {
  return messages.reduce((n, m) => n + (m.role === 'user' ? m.attachments.length : 0), 0);
}
