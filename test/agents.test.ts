/**
 * @jest-environment node
 */
/// <reference types="node" />
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PromptStore, catalogEntries, catalogLicenses, categories, entryIntro, entryName, getEntry, searchCatalog, suggestAvatar } from '../src/agents/catalog';
import { PROMPT_SHARDS } from '../src/agents/shards';
import raw from '../src/agents/catalog.json';
import { setLanguage } from '../src/i18n';
import { BASE_SCHEMA, DEFAULT_GROUP, Repo } from '../src/store/repo';
import { memoryDb } from './helpers/nodeDb';

// 多 AI 討論的資料層：Agent、對話成員、筆記、群組設定，以及內建的圖鑑

function clock(start = 1000) {
  let t = start;
  return () => t++;
}

async function freshRepo() {
  const db = memoryDb();
  const repo = new Repo(db, clock());
  await repo.migrate();
  return { db, repo };
}

afterEach(() => setLanguage('zh-Hant'));

describe('Agent', () => {
  test('自己建的：存角色卡；加到「我的 Agent」才列出來，最近改過的在上面', async () => {
    const { repo } = await freshRepo();
    const card = { expertise: '預算', stance: '先看錢', style: '直接', blindSpot: '忽略長期價值' };
    const cfo = await repo.createAgent({ name: '財務長', intro: '愛挑毛病', card, emoji: '💼', mine: true });
    const other = await repo.createAgent({ name: '路人' });
    const eng = await repo.createAgent({ name: '工程師', mine: true });
    expect((await repo.listMyAgents()).map((a) => a.name)).toEqual(['工程師', '財務長']);
    await repo.updateAgent(cfo.id, { talk: 3, autoJoin: true });
    const got = await repo.getAgent(cfo.id);
    expect(got).toMatchObject({ name: '財務長', card, talk: 1, autoJoin: true, mine: true, prompt: null, catalogId: null });
    expect((await repo.listMyAgents()).map((a) => a.name)).toEqual(['財務長', '工程師']);
    expect(other.mine).toBe(false);
    expect(eng.talk).toBe(0.5);
  });

  test('圖鑑的 Agent 用過就沿用同一份（筆記才接得上）；刪掉後再用是新的一份', async () => {
    const { repo } = await freshRepo();
    const fields = { name: '歷史學家', intro: '講脈絡', emoji: '📚' };
    const a = await repo.agentFromCatalog('agency:academic/academic-historian', fields);
    const b = await repo.agentFromCatalog('agency:academic/academic-historian', fields);
    expect(b.id).toBe(a.id);
    await repo.deleteAgent(a.id);
    const c = await repo.agentFromCatalog('agency:academic/academic-historian', fields);
    expect(c.id).not.toBe(a.id);
  });

  test('從圖鑑來、沒改過的名字和介紹跟著 App 語言；改過的照改過的', async () => {
    const { repo } = await freshRepo();
    const e = getEntry('agency:academic/academic-historian')!;
    const a = await repo.agentFromCatalog(e.id, { name: e.n[0], intro: e.d[0], emoji: e.e });
    const b = await repo.createAgent({ name: '我的歷史老師', intro: '自己寫的介紹', catalogId: 'lobe:chef', mine: true });
    setLanguage('en');
    expect(await repo.getAgent(a.id)).toMatchObject({ name: 'Historian', intro: e.d[1] });
    expect(await repo.getAgent(b.id)).toMatchObject({ name: '我的歷史老師', intro: '自己寫的介紹' });
    setLanguage('zh-Hant');
    expect((await repo.listMyAgents()).map((x) => x.name)).toEqual(['我的歷史老師']);
    expect((await repo.getAgent(a.id))!.name).toBe(e.n[0]);
  });

  test('刪掉的 Agent：不在「我的 Agent」，但說過的話照樣拿得到名字；可以復原', async () => {
    const { repo } = await freshRepo();
    const a = await repo.createAgent({ name: '財務長', mine: true });
    const s = await repo.createSession();
    const m = await repo.addMessage(s.id, { role: 'assistant', content: '預算超了', agentId: a.id });
    await repo.deleteAgent(a.id);
    expect(await repo.listMyAgents()).toEqual([]);
    const [msg] = await repo.listMessages(s.id);
    expect(msg).toMatchObject({ id: m.id, agentId: a.id, replyTo: null });
    expect((await repo.agentsByIds([a.id])).map((x) => x.name)).toEqual(['財務長']);
    await repo.restoreAgent(a.id, true);
    expect((await repo.listMyAgents()).map((x) => x.name)).toEqual(['財務長']);
  });
});

describe('對話成員', () => {
  test('照加入順序；重複加不會變兩個；拿掉；整段對話刪掉成員一起刪', async () => {
    const { db, repo } = await freshRepo();
    const s = await repo.createSession();
    const [a, b, c] = await Promise.all(['甲', '乙', '丙'].map((name) => repo.createAgent({ name })));
    await repo.addMember(s.id, b.id);
    await repo.addMember(s.id, a.id, 'auto');
    await repo.addMember(s.id, b.id, 'mention');
    await repo.addMember(s.id, c.id, 'mention');
    expect((await repo.listMembers(s.id)).map((m) => [m.agent.name, m.joinedBy])).toEqual([
      ['乙', 'user'],
      ['甲', 'auto'],
      ['丙', 'mention'],
    ]);
    await repo.removeMember(s.id, a.id);
    expect((await repo.listMembers(s.id)).map((m) => m.agent.name)).toEqual(['乙', '丙']);
    await repo.deleteSession(s.id);
    expect(await db.get('SELECT COUNT(*) AS n FROM session_members')).toEqual({ n: 0 });
  });

  test('訊息記得是哪個 Agent 說的、回哪一則', async () => {
    const { repo } = await freshRepo();
    const s = await repo.createSession();
    const a = await repo.createAgent({ name: '財務長' });
    const q = await repo.addMessage(s.id, { role: 'user', content: '要換伺服器嗎' });
    await repo.addMessage(s.id, { role: 'assistant', content: '先不要', agentId: a.id, replyTo: q.id });
    expect((await repo.listMessages(s.id)).map((m) => [m.content, m.agentId, m.replyTo])).toEqual([
      ['要換伺服器嗎', null, null],
      ['先不要', a.id, q.id],
    ]);
  });
});

describe('群組設定與前情摘要', () => {
  test('沒設定是 null（照預設）；存了之後讀得回來；缺的欄位補預設', async () => {
    const { db, repo } = await freshRepo();
    const s = await repo.createSession();
    expect(s).toMatchObject({ group: null, summary: '', summarySeq: 0, pinnedId: null });
    const group = { ...DEFAULT_GROUP, mode: 'round' as const, maxStreak: 5 };
    await repo.updateSession(s.id, { group, summary: '前面在吵預算', summarySeq: 12, pinnedId: 'm9' });
    expect(await repo.getSession(s.id)).toMatchObject({ group, summary: '前面在吵預算', summarySeq: 12, pinnedId: 'm9' });
    await db.run('UPDATE sessions SET group_settings = ? WHERE id = ?', ['{"mode":"host"}', s.id]);
    expect((await repo.getSession(s.id))!.group).toEqual({ ...DEFAULT_GROUP, mode: 'host' });
    const t = await repo.createSession({ group: { ...DEFAULT_GROUP, autopilot: true } });
    expect((await repo.getSession(t.id))!.group!.autopilot).toBe(true);
  });
});

describe('Agent 的筆記', () => {
  test('照時間順序；只拿最近幾則；改、刪、清空', async () => {
    const { repo } = await freshRepo();
    const a = await repo.createAgent({ name: '財務長' });
    const notes = [];
    for (const text of ['一', '二', '三']) notes.push(await repo.addNote(a.id, 's1', text));
    expect((await repo.listNotes(a.id)).map((n) => n.content)).toEqual(['一', '二', '三']);
    expect((await repo.listNotes(a.id, 2)).map((n) => n.content)).toEqual(['二', '三']);
    await repo.updateNote(notes[0].id, '一（改）');
    await repo.deleteNote(notes[1].id);
    expect((await repo.listNotes(a.id)).map((n) => n.content)).toEqual(['一（改）', '三']);
    await repo.clearNotes(a.id);
    expect(await repo.listNotes(a.id)).toEqual([]);
  });
});

describe('清除全部資料', () => {
  async function seeded() {
    const { db, repo } = await freshRepo();
    const used = await repo.createAgent({ name: '在對話裡', mine: true });
    const idle = await repo.createAgent({ name: '沒用過', mine: true });
    await repo.addNote(used.id, null, '上次的筆記');
    const s = await repo.createSession();
    await repo.addMember(s.id, used.id);
    await repo.addMessage(s.id, { role: 'assistant', content: '嗨', agentId: used.id });
    return { db, repo, used, idle, s };
  }

  test('那幾秒內按復原：Agent、筆記都回來', async () => {
    const { repo, used } = await seeded();
    const snap = await repo.snapshotSettings();
    const ids = await repo.trashAllSessions();
    await repo.clearSettings();
    expect(await repo.listMyAgents()).toEqual([]);
    expect(await repo.listNotes(used.id)).toEqual([]);
    await repo.restoreSnapshot(snap);
    await repo.restoreSessions(ids);
    expect((await repo.listMyAgents()).map((a) => a.name).sort()).toEqual(['在對話裡', '沒用過']);
    expect((await repo.listNotes(used.id)).map((n) => n.content)).toEqual(['上次的筆記']);
  });

  test('時間到真的刪：沒人用的 Agent 刪掉；救回的對話裡的 Agent 留著（說過的話對得上）', async () => {
    const { repo, used, idle, s } = await seeded();
    const ids = await repo.trashAllSessions();
    await repo.clearSettings();
    await repo.restoreSessions([s.id]);
    await repo.wipe(ids);
    expect(await repo.getAgent(idle.id)).toBeNull();
    expect((await repo.listMembers(s.id)).map((m) => m.agent.name)).toEqual(['在對話裡']);
    expect(await repo.listMyAgents()).toEqual([]);
    expect((await repo.getAgent(used.id))!.deletedAt).not.toBeNull();
  });

  test('刪掉超過 30 天、也沒有對話用到的 Agent：開 App 時真的刪掉', async () => {
    const db = memoryDb();
    let now = 1000;
    const repo = new Repo(db, () => now);
    await repo.migrate();
    const a = await repo.createAgent({ name: '舊的' });
    const b = await repo.createAgent({ name: '還有人用' });
    const s = await repo.createSession();
    await repo.addMessage(s.id, { role: 'assistant', content: '嗨', agentId: b.id });
    await repo.deleteAgent(a.id);
    await repo.deleteAgent(b.id);
    now += 31 * 24 * 60 * 60 * 1000;
    await repo.purgeExpired();
    expect(await repo.getAgent(a.id)).toBeNull();
    expect(await repo.getAgent(b.id)).not.toBeNull();
  });
});

describe('備份與升級', () => {
  test('備份帶著 Agent、成員、筆記', async () => {
    const { repo } = await freshRepo();
    const a = await repo.createAgent({ name: '財務長', mine: true });
    const s = await repo.createSession();
    await repo.addMember(s.id, a.id);
    await repo.addNote(a.id, s.id, '筆記');
    const target = memoryDb();
    await repo.copyTo(target);
    const copy = new Repo(target);
    expect((await copy.listMyAgents()).map((x) => x.name)).toEqual(['財務長']);
    expect((await copy.listMembers(s.id)).map((m) => m.agent.id)).toEqual([a.id]);
    expect((await copy.listNotes(a.id)).map((n) => n.content)).toEqual(['筆記']);
  });

  test('第 6 版的資料庫升級：舊訊息不是 Agent 說的、對話沒有群組設定', async () => {
    const db = memoryDb();
    await db.exec(BASE_SCHEMA);
    await db.exec(`INSERT INTO sessions VALUES ('s1', '舊對話', NULL, NULL, NULL, '', 1, 1);
      INSERT INTO messages VALUES ('m1', 's1', 1, 'user', '舊訊息', '', NULL, NULL, NULL, 1);
      PRAGMA user_version = 1;`);
    const repo = new Repo(db);
    await repo.migrate();
    expect(await db.get('PRAGMA user_version')).toEqual({ user_version: 7 });
    expect((await repo.listMessages('s1')).map((m) => [m.content, m.agentId, m.replyTo])).toEqual([['舊訊息', null, null]]);
    expect((await repo.getSession('s1'))!.group).toBeNull();
    expect(await repo.listMembers('s1')).toEqual([]);
  });
});

describe('圖鑑', () => {
  test('788 個（lobe 505＋agency 283），id 不重複，每個都有繁中與英文的名字、介紹', () => {
    const list = catalogEntries();
    expect(list).toHaveLength(788);
    expect(new Set(list.map((e) => e.id)).size).toBe(788);
    expect(list.filter((e) => e.id.startsWith('lobe:'))).toHaveLength(505);
    expect(list.filter((e) => e.id.startsWith('agency:'))).toHaveLength(283);
    for (const e of list) {
      expect([e.id, ...e.n.map((x) => x.trim().length > 0), ...e.d.map((x) => x.trim().length > 0)]).toEqual([e.id, true, true, true, true]);
    }
  });

  test('12 類，加起來是全部；名稱跟著語言', () => {
    const cats = categories();
    expect(cats).toHaveLength(12);
    expect(cats.reduce((n, c) => n + c.count, 0)).toBe(788);
    expect(cats.every((c) => c.count > 0)).toBe(true);
    expect(cats[0].label).toBe('一般與思考');
    setLanguage('en');
    expect(categories()[0].label).toBe('General & Thinking');
  });

  test('越獄、髒話 4 個有標記（公開前要再檢查）', () => {
    expect(catalogEntries().filter((e) => e.r).map((e) => e.id).sort()).toEqual([
      'lobe:bad-language-helper',
      'lobe:dan',
      'lobe:gpt-4-dan-assistant',
      'lobe:profanity-assistant',
    ]);
  });

  test('授權：兩份 MIT 全文都帶著', () => {
    expect(catalogLicenses().map((l) => l.name)).toEqual(['lobehub/lobe-chat-agents', 'msitarzewski/agency-agents']);
    for (const l of catalogLicenses()) expect(l.text).toContain('MIT License');
  });

  test('名字、介紹跟著 App 語言', () => {
    const chef = getEntry('lobe:chef')!;
    expect(entryName(chef)).toBe(chef.n[0]);
    setLanguage('en');
    expect(entryName(chef)).toBe('Culinary AI Mentor');
    expect(entryIntro(chef)).toBe(chef.d[1]);
  });

  test('搜尋：中英文都找得到；名字對到的排前面；可以只看某一類', () => {
    const hist = searchCatalog('歷史');
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0].n.join(' ')).toContain('歷史');
    expect(searchCatalog('historian').map((e) => e.id)).toContain('agency:academic/academic-historian');
    expect(searchCatalog('HISTORIAN').map((e) => e.id)).toContain('agency:academic/academic-historian');
    expect(searchCatalog('', 'life').every((e) => e.c === 'life')).toBe(true);
    expect(searchCatalog('historian', 'code')).toEqual([]);
    expect(searchCatalog('沒有這種角色xyz')).toEqual([]);
  });

  test('自己建的 Agent 挑頭像：名字對到的優先（不會因為介紹裡有「風險管理」挑到財務專家）', () => {
    expect(suggestAvatar('資安老古', ['漏洞分析', '風險管理', '滲透測試'])).toBe('agency:security/security-architect');
    expect(suggestAvatar('沒有這種人', ['滲透測試'])).toBe('agency:security/security-penetration-tester');
    expect(suggestAvatar('ㄅㄆㄇ', [])).toBeNull();
  });

  test('中文一律台灣正體：名字、介紹、個性、標籤、角色原文都沒有簡體字；每個角色都有中文名字和介紹', () => {
    const simplified = new Set([...readFileSync(join(__dirname, '../scripts/catalog/simplified-chars.txt'), 'utf8').trim()]);
    expect(simplified.has('发')).toBe(true);
    expect(simplified.has('群')).toBe(false);
    const cjk = /[\u4e00-\u9fff]/;
    const bad: string[] = [];
    for (const e of catalogEntries()) {
      const texts = [e.n[0], e.d[0], e.v?.[0] ?? '', ...e.t];
      if (texts.some((x) => [...x].some((c) => simplified.has(c)))) bad.push(e.id);
      if (!cjk.test(e.n[0]) || !cjk.test(e.d[0])) bad.push(`${e.id}（沒有中文）`);
    }
    for (const f of readdirSync(join(__dirname, '../assets/agents')).filter((x) => x.startsWith('prompts-'))) {
      const shard = JSON.parse(readFileSync(join(__dirname, '../assets/agents', f), 'utf8')) as Record<string, { zh?: string }>;
      for (const [id, p] of Object.entries(shard)) if ([...(p.zh ?? '')].some((c) => simplified.has(c))) bad.push(`${id}（角色原文）`);
    }
    expect(bad).toEqual([]);
  });

  test('原文分片：對照表跟索引的分片數一樣', () => {
    expect(PROMPT_SHARDS).toHaveLength((raw as { shards: number }).shards);
  });
});

describe('角色原文', () => {
  test('同一個分片只讀一次；跟著語言；這個語言沒有就用另一個；找不到是空字串', async () => {
    const chef = getEntry('lobe:chef')!;
    const hist = getEntry('agency:academic/academic-historian')!;
    const load = jest.fn(async (i: number) => ({
      ...(i === chef.s ? { 'lobe:chef': { zh: '你是大廚', en: 'You are a chef' } } : {}),
      ...(i === hist.s ? { [hist.id]: { en: 'You are Historian' } } : {}),
    }));
    const store = new PromptStore(load);
    expect(await store.get('lobe:chef')).toBe('你是大廚');
    expect(await store.get(hist.id)).toBe('You are Historian');
    setLanguage('en');
    expect(await store.get('lobe:chef')).toBe('You are a chef');
    expect(await store.get('lobe:nope')).toBe('');
    expect(load).toHaveBeenCalledTimes(new Set([chef.s, hist.s]).size);
  });

  test('讀失敗不會記住，下次再試', async () => {
    const chef = getEntry('lobe:chef')!;
    let fail = true;
    const store = new PromptStore(async () => {
      if (fail) throw new Error('沒網路');
      return { 'lobe:chef': { zh: '你是大廚' } };
    });
    await expect(store.get('lobe:chef')).rejects.toThrow('沒網路');
    fail = false;
    expect(await store.get('lobe:chef')).toBe('你是大廚');
    expect(chef.s).toBeGreaterThanOrEqual(0);
  });
});
