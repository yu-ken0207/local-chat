import type { Message } from '../store/repo';
import type { ChatMessage } from './ollama';

/** 沒設自訂指示時的系統提示詞（依「AI 回答的語言」） */
export const DEFAULT_SYSTEM_PROMPT = '請用繁體中文（台灣用語）回答。';
export const REPLY_PROMPTS = { 'zh-Hant': DEFAULT_SYSTEM_PROMPT, en: 'Please reply in English.' } as const;
/** 只附照片沒打字時，代替使用者問的問題 */
export const DEFAULT_IMAGE_QUESTION = '這張照片裡有什麼？';

/**
 * 把存起來的對話整理成要送給 Ollama 的訊息。
 * - 錯誤、提示這類訊息不送
 * - 模型看不懂圖時拿掉照片，並回報拿掉幾張（畫面要提示使用者）
 * - 思考過程不送回去，只送回答
 */
export function buildChatMessages(
  messages: Message[],
  options: { systemPrompt: string; vision: boolean; defaultSystemPrompt?: string }
): { messages: ChatMessage[]; droppedImages: number } {
  // 自訂指示優先；沒有就用預設（依回答語言）；「不指定語言」時不送系統提示詞
  const system = options.systemPrompt.trim() || (options.defaultSystemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  let droppedImages = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      const images = m.attachments.map((a) => a.base64);
      if (images.length > 0 && !options.vision) droppedImages += images.length;
      out.push({
        role: 'user',
        content: m.content,
        ...(images.length > 0 && options.vision ? { images } : {}),
      });
    } else if (m.role === 'assistant' && m.content.trim()) {
      out.push({ role: 'assistant', content: m.content });
    }
  }
  return { messages: out, droppedImages };
}

/** 對話裡一共有幾張照片 */
export function countImages(messages: Message[]): number {
  return messages.reduce((n, m) => n + (m.role === 'user' ? m.attachments.length : 0), 0);
}
