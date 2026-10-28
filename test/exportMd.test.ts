import { cleanTitle, exportMarkdown, fallbackTitle, fmtDateTime } from '../src/lib/exportMd';
import { fmtWhen } from '../src/lib/format';
import type { Message, Role, Session } from '../src/store/repo';

const session: Session = {
  id: 's',
  title: '午餐討論',
  hostUrl: 'http://a:11434',
  model: 'gemma4:31b',
  think: false,
  systemPrompt: '你是美食家\n回答要簡短',
  createdAt: 0,
  updatedAt: 0,
};

let n = 0;
const msg = (role: Role, content: string, extra: Partial<Message> = {}): Message => ({
  id: String(++n),
  sessionId: 's',
  seq: n,
  role,
  content,
  thinking: '',
  model: role === 'assistant' ? 'gemma4:31b' : null,
  hostLabel: null,
  stats: null,
  createdAt: n,
  attachments: [],
  ...extra,
});

test('匯出 Markdown：標題、模型、角色、時間、你與 AI 的話、照片張數、提示', () => {
  const now = new Date(2026, 9, 28, 19, 5).getTime();
  const md = exportMarkdown(
    session,
    [
      msg('user', '吃什麼？', { attachments: [{ id: 'a', base64: 'x', width: 1, height: 1 }] }),
      msg('assistant', '## 推薦\n\n- 牛肉麵'),
      msg('assistant', '   '),
      msg('note', '已停止'),
    ],
    { hostLabel: '書房電腦', now }
  );
  expect(md).toBe(
    [
      '# 午餐討論',
      '',
      '- 模型：書房電腦 · gemma4:31b',
      '- 角色：你是美食家 回答要簡短',
      '- 匯出時間：2026-10-28 19:05',
      '',
      '---',
      '',
      '**你**：吃什麼？',
      '（附 1 張照片）',
      '',
      '**AI**（gemma4:31b）：',
      '',
      '## 推薦',
      '',
      '- 牛肉麵',
      '',
      '> 已停止',
      '',
    ].join('\n')
  );
  expect(fmtDateTime(now)).toBe('2026-10-28 19:05');
});

test('沒有標題與角色時', () => {
  const md = exportMarkdown({ ...session, title: '', systemPrompt: '', model: null }, [], { hostLabel: '', now: 0 });
  expect(md.startsWith('# 對話\n\n- 匯出時間：')).toBe(true);
  expect(md).not.toContain('角色');
});

test.each([
  ['「午餐推薦」', '午餐推薦'],
  ['標題：**台南牛肉湯**。', '台南牛肉湯'],
  ['# Docker 安裝\n說明…', 'Docker 安裝'],
  ['<think>想一下</think>\n照片中的貓', '照片中的貓'],
  ['這是一個非常非常非常非常長的標題超過二十個字一定會被切掉', '這是一個非常非常非常非常長的標題超過二十'],
  ['  \n  ', ''],
])('整理模型取的標題：%s', (raw, expected) => {
  expect(cleanTitle(raw)).toBe(expected);
});

test('備用標題：第一句話的開頭', () => {
  expect(fallbackTitle('  今天   天氣如何 ')).toBe('今天 天氣如何');
  expect(fallbackTitle('一二三四五六七八九十一二三四五六七八')).toBe('一二三四五六七八九十一二三四五六…');
});

test('對話清單的時間', () => {
  const now = new Date(2026, 9, 28, 19, 5).getTime();
  expect(fmtWhen(new Date(2026, 9, 28, 8, 3).getTime(), now)).toBe('08:03');
  expect(fmtWhen(new Date(2026, 9, 27, 23, 59).getTime(), now)).toBe('昨天');
  expect(fmtWhen(new Date(2026, 0, 2).getTime(), now)).toBe('1/2');
  expect(fmtWhen(new Date(2025, 11, 31).getTime(), now)).toBe('2025/12/31');
});
