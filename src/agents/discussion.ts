import { getLanguage } from '../i18n';
import type { ChatMessage } from '../lib/ollama';
import type { AgentCard, Message } from '../store/repo';

// 多 AI 討論的純邏輯：舉手、選下一個發言的人、@ 誰、組給模型的訊息、上下文預算。
// 給模型的指示不跟著畫面翻譯（i18n-ignore），依 App 語言選一份。

/** 討論裡的一個人（Agent） */
export type Speaker = { id: string; name: string; intro: string; talk: number; position: number };

/** 對話裡的一行：誰說的（Agent id；使用者是 null；一對一時的 AI 是 'ai'） */
export type Line = { id: string; seq: number; who: string | null; name: string; content: string; replyTo: string | null };

const zh = () => getLanguage() !== 'en';
/** 使用者在討論裡的稱呼 */
export const userName = () => (zh() ? '使用者' : 'User'); // i18n-ignore
const plainAiName = () => 'AI';

/** 結論卡那則訊息的 detail */
export const CONCLUSION = 'conclusion';

/** 存起來的訊息整理成討論的一行行（錯誤、提示、工具結果、空的都不算；結論卡算一行，之後接著討論才知道結論是什麼） */
export function toLines(messages: Message[], names: Map<string, string>): Line[] {
  const out: Line[] = [];
  for (const m of messages) {
    if (m.role === 'note' && m.detail === CONCLUSION) {
      const c = parseConclusion(m.content);
      if (c) out.push({ id: m.id, seq: m.seq, who: 'conclusion', name: zh() ? '結論' : 'Conclusion', content: [c.consensus, ...c.todos.map((x) => `- ${x}`)].join('\n'), replyTo: null }); // i18n-ignore
      continue;
    }
    if ((m.role !== 'user' && m.role !== 'assistant') || !m.content.trim()) continue;
    const who = m.role === 'user' ? null : (m.agentId ?? 'ai');
    const name = who === null ? userName() : who === 'ai' ? plainAiName() : (names.get(who) ?? plainAiName());
    out.push({ id: m.id, seq: m.seq, who, name, content: m.content.trim(), replyTo: m.replyTo });
  }
  return out;
}

/** 粗估 token 數：中日韓字（含全形標點）一字約一個，其他約四個字元一個 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 角色原文太長時截短：照段落取到上限為止，後面註明省略 */
export function truncateRole(prompt: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(prompt) <= maxTokens) return { text: prompt, truncated: false };
  const paras = prompt.split(/\n(?=\s*\n)|\n(?=#)/);
  let text = '';
  for (const p of paras) {
    if (estimateTokens(text + p) > maxTokens) break;
    text += p + '\n';
  }
  // 第一段就超過：硬切
  if (!text.trim()) {
    let cut = '';
    for (const ch of prompt) {
      if (estimateTokens(cut + ch) > maxTokens) break;
      cut += ch;
    }
    text = cut;
  }
  return { text: text.trimEnd() + (zh() ? '\n…（角色說明太長，以下省略）' : '\n… (role description truncated)'), truncated: true }; // i18n-ignore
}

/** 自己建的 Agent：角色卡寫成角色說明 */
export function cardPrompt(name: string, intro: string, card: AgentCard | null): string {
  const rows = zh()
    ? [`你是「${name}」。${intro}`, card?.expertise && `專長：${card.expertise}`, card?.stance && `立場與個性：${card.stance}`, card?.style && `說話風格：${card.style}`, card?.blindSpot && `盲點：${card.blindSpot}`] // i18n-ignore
    : [`You are "${name}". ${intro}`, card?.expertise && `Expertise: ${card.expertise}`, card?.stance && `Stance and personality: ${card.stance}`, card?.style && `Speaking style: ${card.style}`, card?.blindSpot && `Blind spot: ${card.blindSpot}`];
  return rows.filter(Boolean).join('\n');
}

/**
 * 名字的簡稱：第一段（空白、括號前面），例如「SRE 網站可靠性工程師」是 SRE、「財務長 (CFO)」是財務長。
 * 模型常用簡稱叫人；太短或跟別人撞名的不算
 */
export function aliasesOf(people: { id: string; name: string }[]): { id: string; name: string }[] {
  const short = people.map((p) => ({ id: p.id, name: p.name.split(/[\s（(]/)[0].trim() })).filter((a, i) => a.name.length >= 2 && a.name !== people[i].name);
  const taken = new Set(people.map((p) => p.name.toLowerCase()));
  // 同一個人的中英文名字可能有同一個簡稱（都是 SRE）：看的是幾個「人」用這個簡稱
  const owners = (n: string) => new Set(short.filter((b) => b.name.toLowerCase() === n).map((b) => b.id));
  const seen = new Set<string>();
  return short.filter((a) => {
    const n = a.name.toLowerCase();
    if (taken.has(n) || owners(n).size !== 1 || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

/** 找出這段話 @ 了誰（全名或簡稱；名字照長的先比，避免「小明」吃掉「小明明」） */
export function findMentions(text: string, people: { id: string; name: string }[]): string[] {
  const lower = text.toLowerCase();
  const sorted = [...people, ...aliasesOf(people)].sort((a, b) => b.name.length - a.name.length);
  const hits: { id: string; at: number }[] = [];
  const taken: [number, number][] = [];
  for (const p of sorted) {
    const needle = '@' + p.name.toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      if (!taken.some(([s, e]) => at < e && end > s)) {
        taken.push([at, end]);
        if (!hits.some((h) => h.id === p.id)) hits.push({ id: p.id, at });
      }
      at = lower.indexOf(needle, end);
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id);
}

/** 回答開頭自己加了名字（「【財務長】」「財務長：」）就拿掉 */
export function cleanReply(text: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*(?:\\*\\*)?(?:【${esc}】|\\[${esc}\\]|${esc}\\s*[：:])(?:\\*\\*)?\\s*`), '').trimStart();
}

const quote = (l: Line, lines: Line[]) => {
  const target = l.replyTo ? lines.find((x) => x.id === l.replyTo) : undefined;
  const to = target ? (zh() ? `（回覆 ${target.name}）` : ` (replying to ${target.name})`) : ''; // i18n-ignore
  return `【${l.name}】${to}${l.content}`;
};

// ---- 舉手 ----

export type Bid = { id: string; score: number; replyTo: string; conclude: boolean };

export const BID_SCHEMA = {
  type: 'object',
  properties: { score: { type: 'integer', minimum: 0, maximum: 10 }, reply_to: { type: 'string' }, conclude: { type: 'boolean' } },
  required: ['score', 'reply_to', 'conclude'],
};

/** 舉手用的訊息：只帶名字、一句話介紹、最近幾則（不帶角色原文，才快） */
export function bidMessages(me: Speaker, members: Speaker[], lines: Line[], outsider = false): ChatMessage[] {
  const names = [userName(), ...members.map((m) => m.name)].join(zh() ? '、' : ', ');
  const recent = lines.slice(-10).map((l) => quote({ ...l, content: l.content.slice(0, 400) }, lines)).join('\n');
  const system = zh()
    ? [
        `你是「${me.name}」：${me.intro}`, // i18n-ignore
        outsider ? `你目前不在這個討論裡（成員：${names}）。只有話題跟你的專長非常相關時才加入。` : `你在一個群組討論裡，成員：${names}。`, // i18n-ignore
        '看最近的對話，判斷你現在有多想發言，只回 JSON：', // i18n-ignore
        '- score：0–10。10＝有重要、新的觀點非講不可；5＝可以補充；0＝沒什麼要說，或你剛講過。', // i18n-ignore
        '- reply_to：想回應誰（填名字），對大家說就填空字串。', // i18n-ignore
        '- conclude：覺得討論已經差不多、可以做結論了就填 true。', // i18n-ignore
      ] // i18n-ignore
    : [
        `You are "${me.name}": ${me.intro}`,
        outsider ? `You are not in this discussion yet (members: ${names}). Only join if the topic is closely related to your expertise.` : `You are in a group discussion. Members: ${names}.`,
        'Read the recent conversation and decide how much you want to speak now. Reply with JSON only:',
        '- score: 0–10. 10 = you have an important new point; 5 = you could add something; 0 = nothing to add, or you just spoke.',
        '- reply_to: the name of the person you want to respond to, or an empty string to address everyone.',
        '- conclude: true if you think the discussion is ready to wrap up with a conclusion.',
      ];
  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: recent || (zh() ? '（還沒有人說話）' : '(Nobody has spoken yet)') }, // i18n-ignore
  ];
}

/** 解析舉手的回覆；不是 JSON 時盡量從文字裡找分數 */
export function parseBid(id: string, text: string): Bid {
  const clamp = (n: number) => Math.max(0, Math.min(10, Math.round(Number.isFinite(n) ? n : 0)));
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const v = JSON.parse(json);
      return { id, score: clamp(Number(v.score)), replyTo: typeof v.reply_to === 'string' ? v.reply_to.trim() : '', conclude: v.conclude === true };
    } catch {
      // 往下用文字找
    }
  }
  const n = text.match(/\b(10|[0-9])\b/);
  return { id, score: n ? clamp(Number(n[1])) : 0, replyTo: '', conclude: false };
}

export const SPEAK_THRESHOLD = 5;
export const OUTSIDER_THRESHOLD = 7;

/** Agent 之間 @ 人：加分（不強制，不然兩個人互 @ 就一直對話，第三個人插不進來） */
export const MENTION_BOOST = 2;
/** 最近 4 輪（Agent 說的）每講一次扣這麼多 */
export const RECENT_PENALTY = 3;

/**
 * 從舉手結果選下一個發言的人（你 @ 的人在這之前就排好了，見 chatStore 的 owed）。
 * - 分數依積極度加減；剛講完的再扣 3；最近 4 輪每講一次扣 3；被別的 Agent @ 到的加 2
 * - 成員要到門檻、還不是成員的（AI 自己加入）門檻更高；同分時最久沒講的先講
 * - mustReply（你剛說完）：大家都沒到門檻也要有一個成員回
 * - skip：這輪舉手出錯的人（電腦連不到），不選
 */
export function chooseSpeaker(
  bids: Bid[],
  people: (Speaker & { member: boolean })[],
  ctx: { lastSpeaker: string | null; mustReply: boolean; boost?: string[]; recent?: string[]; skip?: string[] }
): { id: string; replyTo: string } | null {
  const byId = new Map(people.filter((p) => !ctx.skip?.includes(p.id)).map((p) => [p.id, p]));
  const recent = ctx.recent ?? [];
  const times = (id: string) => recent.filter((x) => x === id).length;
  const spokeAt = (id: string) => recent.lastIndexOf(id);
  const scored = bids
    .filter((b) => byId.has(b.id))
    .map((b) => {
      const p = byId.get(b.id)!;
      const adj = b.score + (p.talk - 0.5) * 4 - (b.id === ctx.lastSpeaker ? 3 : 0) - times(b.id) * RECENT_PENALTY + (ctx.boost?.includes(b.id) ? MENTION_BOOST : 0);
      return { b, p, adj };
    })
    .sort((x, y) => y.adj - x.adj || Number(y.p.member) - Number(x.p.member) || spokeAt(x.b.id) - spokeAt(y.b.id) || x.p.position - y.p.position);
  const pick = scored.find((s) => s.adj >= (s.p.member ? SPEAK_THRESHOLD : OUTSIDER_THRESHOLD)) ?? (ctx.mustReply ? scored.find((s) => s.p.member) : undefined);
  return pick ? { id: pick.b.id, replyTo: pick.b.replyTo } : null;
}

/** 成員裡過半覺得可以收尾 */
export const wantsConclusion = (bids: Bid[], memberIds: Set<string>) => {
  const mine = bids.filter((b) => memberIds.has(b.id));
  return mine.length > 0 && mine.filter((b) => b.conclude).length * 2 > mine.length;
};

/** 輪流：成員順序的下一個 */
export function nextInRound(members: Speaker[], lastSpeaker: string | null): Speaker | null {
  if (members.length === 0) return null;
  const sorted = [...members].sort((a, b) => a.position - b.position);
  const i = sorted.findIndex((m) => m.id === lastSpeaker);
  return sorted[(i + 1) % sorted.length];
}

// ---- 主持人點名 ----

export const HOST_SCHEMA = {
  type: 'object',
  properties: { next: { type: 'string' }, reply_to: { type: 'string' }, conclude: { type: 'boolean' } },
  required: ['next', 'reply_to', 'conclude'],
};

export function hostMessages(members: Speaker[], lines: Line[]): ChatMessage[] {
  const list = members.map((m) => `- ${m.name}：${m.intro}`).join('\n');
  const recent = lines.slice(-12).map((l) => quote({ ...l, content: l.content.slice(0, 400) }, lines)).join('\n');
  const system = zh()
    ? `你是群組討論的主持人，不發言，只決定下一個由誰講。成員：\n${list}\n\n看最近的對話，選最該接著講的人，讓討論有來有往、不要一直同一個人。只回 JSON：next＝下一個人的名字（沒必要再講就填空字串）、reply_to＝他該回應誰（可空）、conclude＝討論是否已經可以做結論。` // i18n-ignore
    : `You are the moderator of a group discussion. You don't speak; you only decide who speaks next. Members:\n${list}\n\nRead the recent conversation and pick who should speak next so the discussion goes back and forth. Reply with JSON only: next = that person's name (empty string if nobody needs to speak), reply_to = who they should respond to (may be empty), conclude = whether the discussion is ready for a conclusion.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: recent || (zh() ? '（還沒有人說話）' : '(Nobody has spoken yet)') }, // i18n-ignore
  ];
}

/** 名字對到人（全名或簡稱；不分大小寫，前後空白、@、【】都不算） */
export function idByName(name: string, people: { id: string; name: string }[]): string | null {
  const n = name.replace(/^[@【\s]+|[】\s]+$/g, '').toLowerCase();
  if (!n) return null;
  return [...people, ...aliasesOf(people)].find((p) => p.name.toLowerCase() === n)?.id ?? null;
}

// ---- 正式發言 ----

/** 群組規則（放在角色說明前面） */
function groupRules(me: Speaker, members: Speaker[], expand: boolean): string {
  const list = members.map((m) => `- ${m.name}：${m.intro}`).join('\n');
  return zh()
    ? [
        `你是「${me.name}」，正在一個多人群組聊天裡討論。成員：`, // i18n-ignore
        `- ${userName()}：發起討論的人，也是其中一員`, // i18n-ignore
        list,
        '',
        '規則：', // i18n-ignore
        `- 你只代表「${me.name}」發言，不要替別人說話，開頭不要寫自己的名字。`, // i18n-ignore
        expand ? '- 這次請完整、詳細地說明，不限長度。' : '- 像聊天一樣，1–4 句，一次講一個重點。', // i18n-ignore
        '- 可以同意、反對、補充或提問；用名字稱呼人，要特別問某人就寫 @名字。', // i18n-ignore
        '- 不要重複別人說過的話；沒有新東西就簡短表態。', // i18n-ignore
        '- 請用繁體中文（台灣用語）回答。', // i18n-ignore
      ].join('\n') // i18n-ignore
    : [
        `You are "${me.name}" in a group chat discussion. Members:`,
        `- ${userName()}: started the discussion and is also a participant`,
        list,
        '',
        'Rules:',
        `- Speak only as "${me.name}". Don't speak for others and don't start with your own name.`,
        expand ? '- This time, explain fully and in detail; no length limit.' : '- Keep it conversational: 1–4 sentences, one point at a time.',
        '- You may agree, disagree, add to, or ask; address people by name, and write @Name to ask someone directly.',
        "- Don't repeat what others said; if you have nothing new, state your position briefly.",
        '- Reply in English.',
      ].join('\n');
}

export type SpeakInput = {
  me: Speaker;
  members: Speaker[];
  /** 角色原文或角色卡寫成的說明 */
  role: string;
  notes: string[];
  summary: string;
  /** 前情摘要涵蓋到第幾則（含） */
  summarySeq: number;
  lines: Line[];
  /** 要回應的那一則 */
  replyTo: string;
  expand?: boolean;
  /** 模型能放的上下文（token） */
  contextTokens: number;
  /** 你最後附的照片（看得懂圖的模型才給）：附在那一則上 */
  images?: { id: string; data: string[] };
};

/** 一段話截到大約 maxTokens，後面註明省略 */
function clip(text: string, maxTokens: number, note: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let out = '';
  for (const ch of text) {
    if (estimateTokens(out + ch) > maxTokens) break;
    out += ch;
  }
  return out + note;
}

/**
 * 組正式發言要送的訊息：群組規則＋角色說明＋筆記、前情摘要、最近幾則（自己說的當 assistant，別人的當 user 加上名字）、最後提醒輪到你。
 * 放不下時：角色說明最多佔四成（截短並回報）、筆記最多一成；對話從最新往回塞，最新一則太長就截短；
 * 要回應的那一則不在裡面（已經摘要過、被擠掉）就把它的內容放進最後的提醒。
 * 塞不下的回報 overflowSeq：要併進前情摘要到這一則為止（多摘一點，摘完剩下的只佔一半，不用每講一則就重摘）
 */
export function speakMessages(input: SpeakInput): { messages: ChatMessage[]; truncatedRole: boolean; overflowSeq: number | null } {
  const { me, lines } = input;
  const ctx = input.contextTokens;
  const answerRoom = Math.max(512, Math.floor(ctx * 0.2));
  const role = truncateRole(input.role, Math.floor(ctx * 0.4));
  // 筆記最多一成：放不下就少帶幾則舊的
  const noteList = [...input.notes];
  while (noteList.length > 0 && estimateTokens(noteList.join('\n')) > ctx * 0.1) noteList.shift();
  const notes = noteList.length
    ? (zh() ? '\n\n你之前討論留下的筆記：\n' : '\n\nYour notes from earlier discussions:\n') + noteList.map((n) => `- ${n}`).join('\n') // i18n-ignore
    : '';
  const roleHead = zh() ? '\n\n以下是你的角色設定：\n' : '\n\nYour role:\n'; // i18n-ignore
  const system = groupRules(me, input.members, !!input.expand) + roleHead + role.text + notes;
  const target = lines.find((l) => l.id === input.replyTo);
  const quoteOf = (t: Line) => clip(t.content, 300, '…');
  const nudgeFor = (withQuote: boolean) => {
    if (zh()) {
      const to = target ? (withQuote ? `，回應【${target.name}】說的：「${quoteOf(target)}」` : `，回應【${target.name}】`) : ''; // i18n-ignore
      return `現在輪到你（${me.name}）發言${to}。直接說你要說的話。`; // i18n-ignore
    }
    const to = target ? (withQuote ? `, responding to what ${target.name} said: "${quoteOf(target)}"` : `, responding to ${target.name}`) : '';
    return `It's your turn (${me.name})${to}. Say what you want to say.`;
  };
  const summary = input.summary ? (zh() ? `前情摘要（之前的討論）：\n${input.summary}` : `Summary of the earlier discussion:\n${input.summary}`) : ''; // i18n-ignore
  // 先替「引用要回應的那一則」留位置，塞完發現它就在裡面再拿掉
  const room0 = ctx - answerRoom - estimateTokens(system) - estimateTokens(summary) - estimateTokens(nudgeFor(!!target));
  let room = room0;
  const recent = lines.filter((l) => l.seq > input.summarySeq);
  const kept: Line[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const cost = estimateTokens(recent[i].content) + 8;
    if (cost > room && kept.length > 0) break;
    // 最新的一則一定要帶（不然不知道在回什麼）：太長就截短
    const line = cost > room ? { ...recent[i], content: clip(recent[i].content, Math.max(200, room - 8), zh() ? '…（太長，後面省略）' : '… (too long, rest omitted)') } : recent[i]; // i18n-ignore
    kept.unshift(line);
    room -= estimateTokens(line.content) + 8;
  }
  let overflow: number | null = null;
  if (recent.length > kept.length) {
    // 摘到剩下的只佔一半
    let half = Math.floor(room0 / 2);
    let keep = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      half -= estimateTokens(recent[i].content) + 8;
      if (half < 0) break;
      keep++;
    }
    keep = Math.max(1, Math.min(keep, kept.length));
    overflow = recent[recent.length - keep - 1].seq;
  }
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  if (summary) messages.push({ role: 'system', content: summary });
  for (const l of kept) {
    if (l.who === me.id) messages.push({ role: 'assistant', content: l.content });
    else messages.push({ role: 'user', content: quote(l, lines), ...(input.images?.id === l.id ? { images: input.images.data } : {}) });
  }
  messages.push({ role: 'system', content: nudgeFor(!!target && !kept.some((l) => l.id === target.id)) });
  return { messages, truncatedRole: role.truncated, overflowSeq: overflow };
}

// ---- 前情摘要 ----

export function summaryMessages(oldSummary: string, lines: Line[]): ChatMessage[] {
  const body = lines.map((l) => quote(l, lines)).join('\n');
  const system = zh()
    ? '把群組討論濃縮成一段前情摘要：保留每個人的主要立場、已經有的共識、還沒解決的問題。300 字以內，用繁體中文（台灣用語）。只回摘要本身。' // i18n-ignore
    : 'Condense the group discussion into a summary: keep each person’s main position, the points already agreed, and the open questions. Under 200 words. Reply with the summary only.';
  const user = (oldSummary ? (zh() ? `之前的摘要：\n${oldSummary}\n\n接下來的對話：\n` : `Earlier summary:\n${oldSummary}\n\nWhat was said next:\n`) : '') + body; // i18n-ignore
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---- 一句話生成角色卡 ----

export const AGENT_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    intro: { type: 'string' },
    expertise: { type: 'string' },
    stance: { type: 'string' },
    style: { type: 'string' },
    blindSpot: { type: 'string' },
    emoji: { type: 'string' },
    talk: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['name', 'intro', 'expertise', 'stance', 'style', 'blindSpot', 'emoji', 'talk'],
};

/** 你寫一句話，請模型補成完整的角色卡；avoid：「再生一個」時不要跟上一個一樣 */
export function agentDraftMessages(idea: string, avoid?: string): ChatMessage[] {
  const system = zh()
    ? [
        '幫使用者設計一個參加群組討論的 AI 角色。照使用者的描述填出（只回 JSON）：', // i18n-ignore
        '- name：稱呼，2–8 個字', // i18n-ignore
        '- intro：一句話介紹，25 個字以內', // i18n-ignore
        '- expertise：專長', // i18n-ignore
        '- stance：立場與個性（他在討論裡通常站哪一邊、在意什麼）', // i18n-ignore
        '- style：說話風格', // i18n-ignore
        '- blindSpot：盲點（讓討論有張力，也讓別人知道要補哪裡）', // i18n-ignore
        '- emoji：一個代表他的 emoji', // i18n-ignore
        '- talk：積極度，0–1（越大越愛發言）', // i18n-ignore
        '用繁體中文（台灣用語）。', // i18n-ignore
      ]
    : [
        'Design an AI character who takes part in group discussions, based on the user’s description. Fill in (reply with JSON only):',
        '- name: what to call them, 1–3 words',
        '- intro: a one-line introduction, under 15 words',
        '- expertise',
        '- stance: their usual position and personality in a discussion, what they care about',
        '- style: how they talk',
        '- blindSpot: their blind spot (adds tension, and tells others what to cover)',
        '- emoji: one emoji that represents them',
        '- talk: how talkative, 0–1',
        'Write in English.',
      ];
  const extra = avoid ? (zh() ? `\n（上一個生成的是「${avoid}」，這次換一個不一樣的角度）` : `\n(The previous one was "${avoid}"; try a different angle this time.)`) : ''; // i18n-ignore
  return [
    { role: 'system', content: system.join('\n') },
    { role: 'user', content: idea.trim() + extra },
  ];
}

// ---- 幫我挑 ----

export const PICK_AGENTS_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: { type: 'object', properties: { mine: { type: 'string' }, zh: { type: 'string' }, en: { type: 'string' }, why: { type: 'string' } }, required: ['zh', 'en', 'why'] },
    },
  },
  required: ['picks'],
};

/** 「找 Agent」「幫我挑」挑人時看得到的使用者自己的 Agent（最多幾個） */
export const MAX_MINE_SHOWN = 30;

/**
 * 照話題挑 3–4 個觀點互補的人：使用者自己的 Agent 有適合的優先（mine 填他的名字），不夠再給職稱（中英文，拿去圖鑑搜尋）；
 * 每個附一句「為什麼找他」
 */
export function pickAgentsMessages(topic: string, mine: { name: string; intro: string }[], avoid: string[] = []): ChatMessage[] {
  const list = mine.slice(0, MAX_MINE_SHOWN).map((a) => `- ${a.name}${a.intro ? `：${clip(a.intro, 60, '…')}` : ''}`).join('\n'); // i18n-ignore
  const system = zh()
    ? [
        '使用者要找幾個人一起討論一個話題。挑 3–4 個適合參加、觀點互補（有人支持、有人質疑、有人看實務）的角色。', // i18n-ignore
        list ? `使用者自己的 Agent 有適合的優先用（mine 填他的名字，一字不差）：\n${list}` : '', // i18n-ignore
        '不夠的再想職稱：zh 是繁體中文職稱（2–6 個字，例如「財務分析師」），en 是英文職稱（例如 Financial Analyst）；用自己的 Agent 時 zh、en 也照他的身分填。', // i18n-ignore
        avoid.length ? `不要再挑這些：${avoid.join('、')}` : '', // i18n-ignore
        'why：一句話說為什麼找他（20 個字以內，繁體中文，台灣用語）。只回 JSON。', // i18n-ignore
      ]
    : [
        'The user wants a few people to discuss a topic together. Pick 3–4 roles with complementary views (someone in favor, someone skeptical, someone practical).',
        list ? `Prefer the user's own agents when they fit (put their exact name in mine):\n${list}` : '',
        'Otherwise give a job title: zh in Traditional Chinese (2–6 characters) and en in English (e.g. Financial Analyst); fill zh and en for the user\'s own agents too.',
        avoid.length ? `Do not pick these again: ${avoid.join(', ')}` : '',
        'why: one short sentence on why this person should join (under 12 words). Reply with JSON only.',
      ];
  return [
    { role: 'system', content: system.filter(Boolean).join('\n') },
    { role: 'user', content: topic.trim() },
  ];
}

// ---- 收尾：列方案、投票、結論卡、筆記 ----

/** 結論卡（存在一則 note 訊息的 content，JSON） */
export type Conclusion = {
  question: string;
  /** who：Agent id，你投的是 'user' */
  options: { text: string; votes: { who: string; name: string; reason: string }[] }[];
  consensus: string;
  disagreements: string[];
  todos: string[];
};

export function parseConclusion(text: string): Conclusion | null {
  try {
    const v = JSON.parse(text);
    return v && Array.isArray(v.options) ? (v as Conclusion) : null;
  } catch {
    return null;
  }
}

/** 收尾時給模型看的討論：前情摘要＋最近 30 則（每則最多 300 字） */
function digest(lines: Line[], summary: string): string {
  const recent = lines.slice(-30).map((l) => quote({ ...l, content: l.content.slice(0, 300) }, lines)).join('\n');
  return (summary ? (zh() ? `前情摘要：${summary}\n\n` : `Summary so far: ${summary}\n\n`) : '') + recent; // i18n-ignore
}

export const OPTIONS_SCHEMA = {
  type: 'object',
  properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 } },
  required: ['question', 'options'],
};

export function optionsMessages(lines: Line[], summary: string): ChatMessage[] {
  const system = zh()
    ? '你是群組討論的整理者。根據討論，寫出要決定的問題（question），以及 2–4 個具體的方案（options，每個 30 字以內，彼此不同）。如果沒有明顯的選項，就用「同意：目前的主要結論」和「不同意」兩個。用繁體中文（台灣用語），只回 JSON。' // i18n-ignore
    : 'You organize a group discussion. Based on it, write the question to decide (question) and 2–4 concrete, distinct options (options, each under 20 words). If there are no obvious options, use "Agree: <the main conclusion so far>" and "Disagree". Reply with JSON only.';
  return [
    { role: 'system', content: system },
    { role: 'user', content: digest(lines, summary) },
  ];
}

export const VOTE_SCHEMA = {
  type: 'object',
  properties: { choice: { type: 'integer', minimum: 1 }, reason: { type: 'string' } },
  required: ['choice', 'reason'],
};

export function voteMessages(me: Speaker, question: string, options: string[], lines: Line[], summary: string): ChatMessage[] {
  const list = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const system = zh()
    ? `你是「${me.name}」：${me.intro}\n討論要做結論了。問題：${question}\n方案：\n${list}\n\n照你在討論裡的立場投一票。只回 JSON：choice＝方案編號、reason＝一句話理由（30 字以內，繁體中文）。` // i18n-ignore
    : `You are "${me.name}": ${me.intro}\nThe discussion is wrapping up. Question: ${question}\nOptions:\n${list}\n\nVote according to your position in the discussion. Reply with JSON only: choice = option number, reason = one-sentence reason (under 20 words).`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: digest(lines, summary) },
  ];
}

export const CONCLUSION_SCHEMA = {
  type: 'object',
  properties: {
    consensus: { type: 'string' },
    disagreements: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    todos: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
  required: ['consensus', 'disagreements', 'todos'],
};

export function conclusionMessages(c: Pick<Conclusion, 'question' | 'options'>, lines: Line[], summary: string): ChatMessage[] {
  const votes = c.options.map((o, i) => `${i + 1}. ${o.text}（${o.votes.length}）${o.votes.map((v) => `\n   - ${v.name}：${v.reason}`).join('')}`).join('\n');
  const system = zh()
    ? `你是群組討論的整理者，要寫結論卡。問題：${c.question}\n投票結果：\n${votes}\n\n只回 JSON：consensus＝大家的共識與決定（2–3 句）、disagreements＝還有分歧的地方（條列，最多 3 點，沒有就空陣列）、todos＝接下來要做的事（條列，最多 4 點）。用繁體中文（台灣用語）。` // i18n-ignore
    : `You organize a group discussion and are writing the conclusion card. Question: ${c.question}\nVotes:\n${votes}\n\nReply with JSON only: consensus = what the group agreed and decided (2–3 sentences), disagreements = remaining disagreements (list, at most 3, empty if none), todos = next steps (list, at most 4).`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: digest(lines, summary) },
  ];
}

export function noteMessages(me: Speaker, conclusion: Conclusion, lines: Line[]): ChatMessage[] {
  const system = zh()
    ? `你是「${me.name}」：${me.intro}\n這次討論結束了，結論：${conclusion.consensus}\n用 1–3 行寫下給下次討論的自己看的筆記：你這次的立場、被說服或新想到的事。只回筆記本身，繁體中文。` // i18n-ignore
    : `You are "${me.name}": ${me.intro}\nThis discussion has ended. Conclusion: ${conclusion.consensus}\nWrite a 1–3 line note for your future self: your position this time and anything you were persuaded of or newly realized. Reply with the note only.`;
  const mine = lines.filter((l) => l.who === me.id).slice(-6).map((l) => `- ${l.content.slice(0, 300)}`).join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: mine || (zh() ? '（這次你沒有發言）' : '(You did not speak this time)') }, // i18n-ignore
  ];
}
