import { DEFAULT_SYSTEM_PROMPT, buildChatMessages, countImages } from '../src/lib/history';
import type { Message, Role } from '../src/store/repo';

let seq = 0;
function msg(role: Role, content: string, images: string[] = []): Message {
  seq++;
  return {
    id: `m${seq}`,
    sessionId: 's',
    seq,
    role,
    content,
    thinking: role === 'assistant' ? '（思考過程）' : '',
    model: null,
    hostLabel: null,
    stats: null,
    detail: '',
    versions: null,
    altGroup: null,
    createdAt: seq,
    attachments: images.map((b, i) => ({ id: `a${seq}-${i}`, base64: b, width: 1, height: 1 })),
  };
}

const CONVERSATION = [
  msg('user', '這是什麼？', ['IMG1', 'IMG2']),
  msg('assistant', '一隻貓和一隻狗'),
  msg('error', '沒有得到回答：連不到主機'),
  msg('note', '已取消'),
  msg('assistant', '   '),
  msg('user', '牠們在做什麼？'),
];

test('看得懂圖的模型：照片照送，錯誤與提示不送，思考過程不送，空白回答不送', () => {
  const { messages, droppedImages } = buildChatMessages(CONVERSATION, { vision: true });
  expect(droppedImages).toBe(0);
  expect(messages).toEqual([
    { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: '這是什麼？', images: ['IMG1', 'IMG2'] },
    { role: 'assistant', content: '一隻貓和一隻狗' },
    { role: 'user', content: '牠們在做什麼？' },
  ]);
});

test('看不懂圖的模型：拿掉照片並回報張數', () => {
  const { messages, droppedImages } = buildChatMessages(CONVERSATION, { vision: false, systemPrompt: 'Please reply in English.' });
  expect(droppedImages).toBe(2);
  expect(messages[0]).toEqual({ role: 'system', content: 'Please reply in English.' });
  expect(messages[1]).toEqual({ role: 'user', content: '這是什麼？' });
  expect(messages.some((m) => m.images)).toBe(false);
});

test('計算照片張數', () => {
  expect(countImages(CONVERSATION)).toBe(2);
  expect(countImages([])).toBe(0);
});
