import type { ThinkSetting } from '../lib/ollama';
import type { Db, SqlValue } from './db';

// ---- 型別 ----

export type Host = {
  url: string;
  label: string;
  source: 'scan' | 'manual';
  version: string;
  lastSeenAt: number | null;
  createdAt: number;
};

export type Session = {
  id: string;
  title: string;
  hostUrl: string | null;
  model: string | null;
  think: ThinkSetting | null;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
};

export type Attachment = { id: string; base64: string; width: number; height: number };

export type MessageStats = {
  evalCount: number;
  evalDurationNs: number;
  promptEvalCount: number;
  totalDurationNs: number;
};

export type Role = 'user' | 'assistant' | 'error' | 'note';

export type Message = {
  id: string;
  sessionId: string;
  seq: number;
  role: Role;
  content: string;
  thinking: string;
  model: string | null;
  hostLabel: string | null;
  stats: MessageStats | null;
  createdAt: number;
  attachments: Attachment[];
};

export type Template = { id: string; title: string; content: string; position: number };

// ---- 資料表 ----

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
  url TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  host_url TEXT,
  model TEXT,
  think TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT NOT NULL DEFAULT '',
  model TEXT,
  host_label TEXT,
  stats TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, seq);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  base64 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_by_message ON attachments(message_id, seq);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 第一次開 App 時放進去的常用提示詞範本（之後可以自己改） */
export const DEFAULT_TEMPLATES: { title: string; content: string }[] = [
  { title: '翻譯成英文', content: '把下面這段翻譯成自然的英文：\n' },
  { title: '翻譯成中文', content: '把下面這段翻譯成繁體中文（台灣用語）：\n' },
  { title: '摘要重點', content: '用條列整理下面內容的重點：\n' },
  { title: '描述照片', content: '詳細描述這張照片裡有什麼。' },
  { title: '找出異常', content: '這張照片裡有沒有不正常、需要注意的地方？有的話說明位置和原因。' },
  { title: '解釋程式碼', content: '解釋下面這段程式碼在做什麼：\n' },
];

let idCounter = 0;
/** 產生不重複的 id（時間＋計數＋亂數） */
export function newId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
}

/** LIKE 查詢用：把 % _ \ 跳脫，避免使用者打的字被當成萬用字元 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
}

function encodeThink(think: ThinkSetting | null): string | null {
  return think === null ? null : JSON.stringify(think);
}

function decodeThink(raw: string | null): ThinkSetting | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === 'boolean' || typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

type SessionRow = {
  id: string;
  title: string;
  host_url: string | null;
  model: string | null;
  think: string | null;
  system_prompt: string;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  seq: number;
  role: Role;
  content: string;
  thinking: string;
  model: string | null;
  host_label: string | null;
  stats: string | null;
  created_at: number;
};

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  title: r.title,
  hostUrl: r.host_url,
  model: r.model,
  think: decodeThink(r.think),
  systemPrompt: r.system_prompt,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class Repo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** 建表；第一次建立時放入預設範本 */
  async migrate(): Promise<void> {
    const row = await this.db.get<{ user_version: number }>('PRAGMA user_version');
    const version = row?.user_version ?? 0;
    if (version >= SCHEMA_VERSION) return;
    await this.db.exec(SCHEMA);
    if (version === 0) await this.seedTemplates();
    await this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // ---- 主機 ----

  /** 新增或更新主機；手動加的不會被掃描結果改成 scan */
  async saveHost(host: { url: string; label: string; source: 'scan' | 'manual'; version?: string }): Promise<void> {
    const now = this.now();
    await this.db.run(
      `INSERT INTO hosts (url, label, source, version, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         label = CASE WHEN hosts.source = 'manual' AND excluded.source = 'scan' THEN hosts.label ELSE excluded.label END,
         source = CASE WHEN hosts.source = 'manual' THEN 'manual' ELSE excluded.source END,
         version = CASE WHEN excluded.version = '' THEN hosts.version ELSE excluded.version END,
         last_seen_at = COALESCE(excluded.last_seen_at, hosts.last_seen_at)`,
      [host.url, host.label, host.source, host.version ?? '', host.version ? now : null, now]
    );
  }

  async markHostSeen(url: string, version: string): Promise<void> {
    await this.db.run('UPDATE hosts SET version = ?, last_seen_at = ? WHERE url = ?', [version, this.now(), url]);
  }

  async renameHost(url: string, label: string): Promise<void> {
    await this.db.run('UPDATE hosts SET label = ? WHERE url = ?', [label, url]);
  }

  async listHosts(): Promise<Host[]> {
    const rows = await this.db.all<any>('SELECT * FROM hosts ORDER BY created_at, url');
    return rows.map((r) => ({
      url: r.url,
      label: r.label,
      source: r.source,
      version: r.version,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    }));
  }

  async removeHost(url: string): Promise<void> {
    await this.db.run('DELETE FROM hosts WHERE url = ?', [url]);
  }

  // ---- 對話 ----

  async createSession(init: { hostUrl?: string | null; model?: string | null; think?: ThinkSetting | null; systemPrompt?: string } = {}): Promise<Session> {
    const now = this.now();
    const s: Session = {
      id: newId(),
      title: '',
      hostUrl: init.hostUrl ?? null,
      model: init.model ?? null,
      think: init.think ?? null,
      systemPrompt: init.systemPrompt ?? '',
      createdAt: now,
      updatedAt: now,
    };
    await this.db.run(
      'INSERT INTO sessions (id, title, host_url, model, think, system_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [s.id, s.title, s.hostUrl, s.model, encodeThink(s.think), s.systemPrompt, s.createdAt, s.updatedAt]
    );
    return s;
  }

  async getSession(id: string): Promise<Session | null> {
    const row = await this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
    return row ? toSession(row) : null;
  }

  /** 改對話設定（標題、主機、模型、思考、角色）；不會改「最後更新時間」，免得只是換模型就跳到清單最上面 */
  async updateSession(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'hostUrl' | 'model' | 'think' | 'systemPrompt'>>
  ): Promise<void> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const add = (col: string, value: SqlValue) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.title !== undefined) add('title', patch.title);
    if (patch.hostUrl !== undefined) add('host_url', patch.hostUrl);
    if (patch.model !== undefined) add('model', patch.model);
    if (patch.think !== undefined) add('think', encodeThink(patch.think));
    if (patch.systemPrompt !== undefined) add('system_prompt', patch.systemPrompt);
    if (sets.length === 0) return;
    await this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }

  /**
   * 對話清單，最近有新訊息的在上面。有 search 時比對標題與訊息內容（不分大小寫）。
   * preview 是最後一則使用者或 AI 訊息的開頭。
   */
  async listSessions(search = ''): Promise<(Session & { preview: string })[]> {
    const q = search.trim();
    const where = q
      ? `WHERE s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\')`
      : '';
    const params = q ? [likePattern(q), likePattern(q)] : [];
    const rows = await this.db.all<SessionRow & { preview: string | null }>(
      `SELECT s.*, (SELECT substr(m.content, 1, 80) FROM messages m WHERE m.session_id = s.id AND m.role IN ('user', 'assistant') ORDER BY m.seq DESC LIMIT 1) AS preview
       FROM sessions s ${where} ORDER BY s.updated_at DESC, s.created_at DESC`,
      params
    );
    return rows.map((r) => ({ ...toSession(r), preview: r.preview ?? '' }));
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  /** 刪掉沒有任何訊息的空白對話（開了新對話卻沒講話） */
  async deleteEmptySessions(exceptId?: string): Promise<void> {
    await this.db.run(
      'DELETE FROM sessions WHERE id != ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)',
      [exceptId ?? '']
    );
  }

  // ---- 訊息 ----

  async addMessage(
    sessionId: string,
    m: {
      role: Role;
      content: string;
      thinking?: string;
      model?: string | null;
      hostLabel?: string | null;
      stats?: MessageStats | null;
      attachments?: Omit<Attachment, 'id'>[];
    }
  ): Promise<Message> {
    const now = this.now();
    const last = await this.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM messages WHERE session_id = ?', [sessionId]);
    const seq = (last?.seq ?? 0) + 1;
    const msg: Message = {
      id: newId(),
      sessionId,
      seq,
      role: m.role,
      content: m.content,
      thinking: m.thinking ?? '',
      model: m.model ?? null,
      hostLabel: m.hostLabel ?? null,
      stats: m.stats ?? null,
      createdAt: now,
      attachments: (m.attachments ?? []).map((a) => ({ ...a, id: newId() })),
    };
    await this.db.run(
      'INSERT INTO messages (id, session_id, seq, role, content, thinking, model, host_label, stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [msg.id, sessionId, seq, msg.role, msg.content, msg.thinking, msg.model, msg.hostLabel, msg.stats ? JSON.stringify(msg.stats) : null, now]
    );
    for (const [i, a] of msg.attachments.entries()) {
      await this.db.run('INSERT INTO attachments (id, message_id, seq, base64, width, height) VALUES (?, ?, ?, ?, ?, ?)', [
        a.id,
        msg.id,
        i,
        a.base64,
        a.width,
        a.height,
      ]);
    }
    await this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
    return msg;
  }

  /** 回答串流結束後把完整內容與統計寫回去 */
  async updateMessage(id: string, patch: { content?: string; thinking?: string; stats?: MessageStats | null; role?: Role }): Promise<void> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.content !== undefined) {
      sets.push('content = ?');
      params.push(patch.content);
    }
    if (patch.thinking !== undefined) {
      sets.push('thinking = ?');
      params.push(patch.thinking);
    }
    if (patch.stats !== undefined) {
      sets.push('stats = ?');
      params.push(patch.stats ? JSON.stringify(patch.stats) : null);
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (sets.length === 0) return;
    await this.db.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    const rows = await this.db.all<MessageRow>('SELECT * FROM messages WHERE session_id = ? ORDER BY seq', [sessionId]);
    const atts = await this.db.all<{ id: string; message_id: string; base64: string; width: number; height: number }>(
      'SELECT a.id, a.message_id, a.base64, a.width, a.height FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.session_id = ? ORDER BY a.message_id, a.seq',
      [sessionId]
    );
    const byMessage = new Map<string, Attachment[]>();
    for (const a of atts) {
      const list = byMessage.get(a.message_id) ?? [];
      list.push({ id: a.id, base64: a.base64, width: a.width, height: a.height });
      byMessage.set(a.message_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      thinking: r.thinking,
      model: r.model,
      hostLabel: r.host_label,
      stats: r.stats ? (JSON.parse(r.stats) as MessageStats) : null,
      createdAt: r.created_at,
      attachments: byMessage.get(r.id) ?? [],
    }));
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  /** 刪掉某則訊息（含）之後的所有訊息：編輯重送、重新產生時用 */
  async deleteMessagesFrom(sessionId: string, seq: number): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE session_id = ? AND seq >= ?', [sessionId, seq]);
  }

  // ---- 提示詞範本 ----

  async listTemplates(): Promise<Template[]> {
    return this.db.all<Template>('SELECT id, title, content, position FROM templates ORDER BY position, title');
  }

  async addTemplate(title: string, content: string): Promise<Template> {
    const last = await this.db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM templates');
    const t: Template = { id: newId(), title, content, position: (last?.p ?? -1) + 1 };
    await this.db.run('INSERT INTO templates (id, title, content, position) VALUES (?, ?, ?, ?)', [t.id, t.title, t.content, t.position]);
    return t;
  }

  async updateTemplate(id: string, title: string, content: string): Promise<void> {
    await this.db.run('UPDATE templates SET title = ?, content = ? WHERE id = ?', [title, content, id]);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.db.run('DELETE FROM templates WHERE id = ?', [id]);
  }

  // ---- 資料庫檔案 ----

  /** 刪除所有對話（連訊息與照片），保留主機、範本、設定；之後壓縮檔案釋放空間 */
  async deleteAllSessions(): Promise<void> {
    await this.db.run('DELETE FROM sessions');
    await this.db.exec('VACUUM');
  }

  /** 清除全部資料，回到第一次打開的樣子（範本恢復成預設） */
  async resetAll(): Promise<void> {
    await this.db.exec('DELETE FROM sessions; DELETE FROM hosts; DELETE FROM templates; DELETE FROM settings;');
    await this.seedTemplates();
    await this.db.exec('VACUUM');
  }

  private async seedTemplates(): Promise<void> {
    for (const [i, t] of DEFAULT_TEMPLATES.entries()) {
      await this.db.run('INSERT INTO templates (id, title, content, position) VALUES (?, ?, ?, ?)', [newId(), t.title, t.content, i]);
    }
  }

  /** 對話有幾段 */
  async countSessions(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))?.n ?? 0;
  }

  /** 資料庫目前的大小（位元組） */
  async sizeBytes(): Promise<number> {
    const count = (await this.db.get<{ page_count: number }>('PRAGMA page_count'))?.page_count ?? 0;
    const size = (await this.db.get<{ page_size: number }>('PRAGMA page_size'))?.page_size ?? 0;
    return count * size;
  }

  /** 把暫存在 -wal 檔的寫入合併回主檔，匯出的檔案才完整 */
  async checkpoint(): Promise<void> {
    await this.db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  dbPath(): string | null {
    return this.db.path ?? null;
  }

  // ---- 設定 ----

  async getSetting(key: string): Promise<string | null> {
    return (await this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }
}
