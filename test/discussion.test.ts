/**
 * @jest-environment node
 */
import {
  bidMessages,
  cardPrompt,
  chooseSpeaker,
  cleanReply,
  estimateTokens,
  findMentions,
  hostMessages,
  idByName,
  nextInRound,
  parseBid,
  speakMessages,
  summaryMessages,
  toLines,
  truncateRole,
  wantsConclusion,
  type Line,
  type Speaker,
} from '../src/agents/discussion';
import { setLanguage } from '../src/i18n';
import type { Message } from '../src/store/repo';

// 多 AI 討論的純邏輯

afterEach(() => setLanguage('zh-Hant'));

const sp = (id: string, name: string, position: number, talk = 0.5): Speaker => ({ id, name, intro: `${name}的介紹`, talk, position });
const CFO = sp('cfo', '財務長', 0);
const ENG = sp('eng', '工程師', 1);
const PM = sp('pm', '產品經理', 2);

let seq = 0;
const line = (who: string | null, name: string, content: string, replyTo: string | null = null): Line => ({ id: `m${++seq}`, seq, who, name, content, replyTo });

function msg(p: Partial<Message>): Message {
  return {
    id: `x${++seq}`,
    sessionId: 's',
    seq,
    role: 'user',
    content: '',
    thinking: '',
    model: null,
    hostLabel: null,
    stats: null,
    detail: '',
    createdAt: 0,
    attachments: [],
    versions: null,
    altGroup: null,
    agentId: null,
    replyTo: null,
    ...p,
  };
}

describe('整理成一行行', () => {
  test('使用者、Agent、一對一時的 AI；錯誤、提示、空的不算', () => {
    const lines = toLines(
      [
        msg({ role: 'user', content: '要換伺服器嗎' }),
        msg({ role: 'assistant', content: '我覺得要', agentId: null }),
        msg({ role: 'assistant', content: '先不要', agentId: 'cfo' }),
        msg({ role: 'error', content: '連不到' }),
        msg({ role: 'note', content: '已停止' }),
        msg({ role: 'assistant', content: '  ', agentId: 'eng' }),
        msg({ role: 'assistant', content: '我是誰', agentId: 'gone' }),
      ],
      new Map([['cfo', '財務長']])
    );
    expect(lines.map((l) => [l.who, l.name, l.content])).toEqual([
      [null, '使用者', '要換伺服器嗎'],
      ['ai', 'AI', '我覺得要'],
      ['cfo', '財務長', '先不要'],
      ['gone', 'AI', '我是誰'],
    ]);
  });
});

describe('上下文', () => {
  test('粗估 token：中文一字一個，英文約四個字元一個', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好 abcd')).toBe(2 + 2);
    expect(estimateTokens('好。')).toBe(2);
  });

  test('角色說明放得下就不動；太長照段落截，最後註明省略；一段就太長硬切', () => {
    expect(truncateRole('短短的', 100)).toEqual({ text: '短短的', truncated: false });
    const long = ['# 身分', '你是歷史學家。', '', '## 方法', 'x'.repeat(400), '', '## 交付', 'y'.repeat(400)].join('\n');
    const cut = truncateRole(long, 60);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain('你是歷史學家');
    expect(cut.text).not.toContain('yyyy');
    expect(cut.text).toMatch(/以下省略/);
    const one = truncateRole('字'.repeat(500), 50);
    expect(estimateTokens(one.text)).toBeLessThan(80);
  });
});

describe('@ 誰', () => {
  const people = [
    { id: 'a', name: '小明' },
    { id: 'b', name: '小明明' },
    { id: 'c', name: 'Bob' },
  ];
  test('照出現順序；名字長的先比；不分大小寫；沒有 @ 不算', () => {
    expect(findMentions('@bob 你看呢？還有 @小明明', people)).toEqual(['c', 'b']);
    expect(findMentions('@小明 跟 @小明明', people)).toEqual(['a', 'b']);
    expect(findMentions('小明你說呢', people)).toEqual([]);
  });

  test('簡稱也算：「SRE 網站可靠性工程師」可以寫 @SRE；撞名或太短的簡稱不算', () => {
    const team = [
      { id: 's', name: 'SRE 網站可靠性工程師' },
      { id: 'c', name: '財務長 (CFO)' },
      { id: 'a', name: 'A 小組' },
      { id: 'x', name: '工程師 甲' },
      { id: 'y', name: '工程師 乙' },
    ];
    expect(findMentions('@SRE 幫我確認，@財務長 也看一下', team)).toEqual(['s', 'c']);
    expect(findMentions('@SRE 網站可靠性工程師 你好', team)).toEqual(['s']);
    expect(findMentions('@A 你呢', team)).toEqual([]);
    expect(findMentions('@工程師 誰都可以', team)).toEqual([]);
    expect(idByName('SRE', team)).toBe('s');
    expect(idByName('財務長', team)).toBe('c');
  });

  test('名字對到人', () => {
    expect(idByName('@小明', people)).toBe('a');
    expect(idByName('【BOB】', people)).toBe('c');
    expect(idByName('', people)).toBeNull();
    expect(idByName('路人', people)).toBeNull();
  });
});

test('回答開頭自己加了名字就拿掉', () => {
  expect(cleanReply('【財務長】預算超了', '財務長')).toBe('預算超了');
  expect(cleanReply('財務長：預算超了', '財務長')).toBe('預算超了');
  expect(cleanReply('**財務長:** 預算超了', '財務長')).toBe('預算超了');
  expect(cleanReply('我是財務長：預算超了', '財務長')).toBe('我是財務長：預算超了');
});

describe('舉手', () => {
  test('解析：JSON、包在文字裡的 JSON、只有數字、亂七八糟', () => {
    expect(parseBid('a', '{"score": 8, "reply_to": " 工程師 ", "conclude": true}')).toEqual({ id: 'a', score: 8, replyTo: '工程師', conclude: true });
    expect(parseBid('a', '好的：\n{"score": 12, "reply_to": "", "conclude": false}')).toMatchObject({ score: 10 });
    expect(parseBid('a', '我給 7 分')).toEqual({ id: 'a', score: 7, replyTo: '', conclude: false });
    expect(parseBid('a', '不知道')).toMatchObject({ score: 0 });
  });

  test('舉手只帶名字與介紹、最近 10 則；還不是成員的說明不一樣', () => {
    const lines = Array.from({ length: 14 }, (_, i) => line(null, '使用者', `第${i}句`));
    const [sys, user] = bidMessages(CFO, [CFO, ENG], lines);
    expect(sys.content).toContain('財務長的介紹');
    expect(sys.content).toContain('使用者、財務長、工程師');
    expect(user.content).not.toContain('第3句');
    expect(user.content).toContain('第13句');
    expect(bidMessages(PM, [CFO, ENG], lines, true)[0].content).toContain('你目前不在這個討論裡');
  });

  const people = [
    { ...CFO, member: true },
    { ...ENG, member: true },
    { ...PM, member: false },
  ];
  const ctx = { lastSpeaker: null, mentioned: [] as string[], mustReply: false };

  test('分數最高的講；剛講完的扣分；積極度加減', () => {
    const bids = [
      { id: 'cfo', score: 7, replyTo: '', conclude: false },
      { id: 'eng', score: 6, replyTo: '財務長', conclude: false },
    ];
    expect(chooseSpeaker(bids, people, ctx)).toEqual({ id: 'cfo', replyTo: '' });
    expect(chooseSpeaker(bids, people, { ...ctx, lastSpeaker: 'cfo' })).toEqual({ id: 'eng', replyTo: '財務長' });
    const shy = [{ ...CFO, talk: 0, member: true }, { ...ENG, member: true }];
    expect(chooseSpeaker(bids, shy, ctx)!.id).toBe('eng');
  });

  test('被 @ 的一定講（跳過剛講完的）', () => {
    const bids = [{ id: 'cfo', score: 9, replyTo: '', conclude: false }];
    expect(chooseSpeaker(bids, people, { ...ctx, mentioned: ['eng'] })!.id).toBe('eng');
    expect(chooseSpeaker(bids, people, { ...ctx, mentioned: ['cfo', 'eng'], lastSpeaker: 'cfo' })!.id).toBe('eng');
  });

  test('都沒到門檻：停；你剛說完就讓最高的成員回；還不是成員的要更高分', () => {
    const low = [
      { id: 'cfo', score: 2, replyTo: '', conclude: false },
      { id: 'eng', score: 4, replyTo: '', conclude: false },
      { id: 'pm', score: 6, replyTo: '', conclude: false },
    ];
    expect(chooseSpeaker(low, people, ctx)).toBeNull();
    expect(chooseSpeaker(low, people, { ...ctx, mustReply: true })!.id).toBe('eng');
    expect(chooseSpeaker([...low.slice(0, 2), { id: 'pm', score: 8, replyTo: '', conclude: false }], people, ctx)!.id).toBe('pm');
  });

  test('過半成員覺得可以收尾', () => {
    const ids = new Set(['cfo', 'eng', 'pm']);
    const b = (id: string, conclude: boolean) => ({ id, score: 0, replyTo: '', conclude });
    expect(wantsConclusion([b('cfo', true), b('eng', true), b('pm', false)], ids)).toBe(true);
    expect(wantsConclusion([b('cfo', true), b('eng', false)], ids)).toBe(false);
    expect(wantsConclusion([b('x', true)], ids)).toBe(false);
  });
});

test('輪流：成員順序的下一個，最後一個之後回到第一個', () => {
  expect(nextInRound([ENG, CFO], null)!.id).toBe('cfo');
  expect(nextInRound([CFO, ENG], 'cfo')!.id).toBe('eng');
  expect(nextInRound([CFO, ENG], 'eng')!.id).toBe('cfo');
  expect(nextInRound([], null)).toBeNull();
});

test('主持人：列出成員與最近的對話', () => {
  const [sys, user] = hostMessages([CFO, ENG], [line(null, '使用者', '要換伺服器嗎')]);
  expect(sys.content).toContain('- 財務長：財務長的介紹');
  expect(user.content).toBe('【使用者】要換伺服器嗎');
});

describe('正式發言', () => {
  const base = { me: ENG, members: [CFO, ENG], role: '你是工程師。', notes: [], summary: '', summarySeq: 0, replyTo: '', contextTokens: 8000 };

  test('自己說的當 assistant，別人的當 user 加上名字與回覆對象；最後提醒輪到你、回應誰', () => {
    const q = line(null, '使用者', '要換伺服器嗎');
    const a = line('cfo', '財務長', '預算超了', q.id);
    const b = line('eng', '工程師', '舊的常當機');
    const { messages, truncatedRole, overflowSeq } = speakMessages({ ...base, lines: [q, a, b], replyTo: a.id, notes: ['上次主張先修再換'] });
    expect(messages.map((m) => [m.role, m.content.slice(0, 40)])).toEqual([
      ['system', expect.stringContaining('你是「工程師」')],
      ['user', '【使用者】要換伺服器嗎'],
      ['user', '【財務長】（回覆 使用者）預算超了'],
      ['assistant', '舊的常當機'],
      ['system', '現在輪到你（工程師）發言，回應【財務長】。直接說你要說的話。'],
    ]);
    expect(messages[0].content).toContain('1–4 句');
    expect(messages[0].content).toContain('你是工程師。');
    expect(messages[0].content).toContain('- 上次主張先修再換');
    expect([truncatedRole, overflowSeq]).toEqual([false, null]);
  });

  test('請他展開講：不限長度', () => {
    const { messages } = speakMessages({ ...base, lines: [line(null, '使用者', '詳細說')], expand: true });
    expect(messages[0].content).toContain('不限長度');
    expect(messages[0].content).not.toContain('1–4 句');
  });

  test('有前情摘要：放在前面，已經摘要過的不再送', () => {
    const old = line(null, '使用者', '很久以前的話');
    const now = line('cfo', '財務長', '最新的話');
    const { messages } = speakMessages({ ...base, lines: [old, now], summary: '大家在吵預算', summarySeq: old.seq });
    expect(messages[1]).toEqual({ role: 'system', content: '前情摘要（之前的討論）：\n大家在吵預算' });
    expect(messages.map((m) => m.content).join('\n')).not.toContain('很久以前的話');
  });

  test('上下文太小：角色說明截短；舊的對話放不下，回報要摘要到第幾則；最新一則一定帶', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(i % 2 ? 'cfo' : null, i % 2 ? '財務長' : '使用者', `第${i}句`.padEnd(120, '。')));
    const { messages, truncatedRole, overflowSeq } = speakMessages({ ...base, lines, role: '角色'.repeat(3000), contextTokens: 2048 });
    expect(truncatedRole).toBe(true);
    expect(overflowSeq).not.toBeNull();
    expect(messages.at(-2)!.content).toContain('第29句');
    expect(messages.map((m) => m.content).join('\n')).not.toContain('第0句');
    const kept = lines.filter((l) => l.seq > overflowSeq!);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(kept.filter((l) => l.who !== 'eng').length);
  });

  test('英文：規則、提醒都是英文', () => {
    setLanguage('en');
    const { messages } = speakMessages({ ...base, lines: [line(null, 'User', 'Should we?')] });
    expect(messages[0].content).toContain('1–4 sentences');
    expect(messages[0].content).toContain('Reply in English.');
    expect(messages.at(-1)!.content).toBe("It's your turn (工程師). Say what you want to say.");
  });
});

test('角色卡寫成角色說明（沒填的欄位不寫）', () => {
  expect(cardPrompt('財務長', '愛挑毛病', { expertise: '預算', stance: '', style: '直接', blindSpot: '' })).toBe('你是「財務長」。愛挑毛病\n專長：預算\n說話風格：直接');
  expect(cardPrompt('財務長', '愛挑毛病', null)).toBe('你是「財務長」。愛挑毛病');
});

test('前情摘要：帶著之前的摘要和接下來的對話', () => {
  const [sys, user] = summaryMessages('先前在吵預算', [line('cfo', '財務長', '超了 8%')]);
  expect(sys.content).toContain('前情摘要');
  expect(user.content).toBe('之前的摘要：\n先前在吵預算\n\n接下來的對話：\n【財務長】超了 8%');
});
