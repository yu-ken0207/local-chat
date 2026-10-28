import type { ThinkSetting } from '../lib/ollama';
import type { Db, SqlValue } from './db';
import { t } from '../i18n';

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
  /** 錯誤的技術細節（畫面上預設收起來） */
  detail: string;
  createdAt: number;
  attachments: Attachment[];
  /** 重新產生過的回答：目前是第幾個版本、一共幾個（沒有其他版本是 null） */
  versions: { index: number; total: number } | null;
  /** 同一題的不同回答版本共用這個代號 */
  altGroup: string | null;
};

export type Template = { id: string; title: string; content: string; position: number };

// ---- 資料表 ----

const SCHEMA_VERSION = 3;

/** 每一版要做的改變（舊版資料庫照順序補上） */
const MIGRATIONS: Record<number, string> = {
  2: "ALTER TABLE messages ADD COLUMN detail TEXT NOT NULL DEFAULT ''",
  // 刪除先放「最近刪除」（可以復原）；重新產生保留舊回答當版本
  3: `ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;
      ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
      ALTER TABLE messages ADD COLUMN alt_group TEXT;
      ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`,
};

/** 最近刪除保留幾天 */
export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 第 1 版的資料表（之後的改變在 MIGRATIONS） */
export const BASE_SCHEMA = `
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
export const defaultTemplates = (): { title: string; content: string }[] => [
  { title: t('翻譯成英文'), content: t('把下面這段翻譯成自然的英文：\n') },
  { title: t('翻譯成中文'), content: t('把下面這段翻譯成繁體中文：\n') },
  { title: t('摘要重點'), content: t('用條列整理下面內容的重點：\n') },
  { title: t('潤飾文字'), content: t('幫我把下面這段改得更通順、更好讀：\n') },
  { title: t('描述照片'), content: t('詳細描述這張照片裡有什麼。') },
  { title: t('照片裡的文字'), content: t('把這張照片裡的文字完整抄下來。') },
]

/** 備份會帶走的資料表（照這個順序放回去，先放被參照的） */
const BACKUP_TABLES = ['hosts', 'sessions', 'messages', 'attachments', 'templates', 'settings'] as const;

export class NotBackupError extends Error {
  constructor() {
    super(t('這個檔案不是這個 App 的備份。'));
    this.name = 'NotBackupError';
  }
}

/** 確認是這個 App 的資料庫：要有對話與訊息兩張表 */
async function assertBackup(db: Db): Promise<void> {
  try {
    const rows = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = new Set(rows.map((r) => r.name));
    if (!names.has('sessions') || !names.has('messages')) throw new NotBackupError();
  } catch (e) {
    throw e instanceof NotBackupError ? e : new NotBackupError();
  }
}

/** 看得到的訊息：沒被刪除、也不是收起來的舊版本 */
const VISIBLE = 'm.deleted_at IS NULL AND m.hidden = 0';
/** 對話預覽：最後一則看得到的使用者或 AI 訊息 */
const PREVIEW = `(SELECT substr(m.content, 1, 80) FROM messages m WHERE m.session_id = s.id AND ${VISIBLE} AND m.role IN ('user', 'assistant') ORDER BY m.seq DESC LIMIT 1)`;

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
  detail: string;
  alt_group: string | null;
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
    if (version === 0) {
      await this.db.exec(BASE_SCHEMA);
      await this.seedTemplates();
    }
    for (let v = Math.max(version, 1) + 1; v <= SCHEMA_VERSION; v++) await this.db.exec(MIGRATIONS[v]);
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

  /** 把移除的電腦原樣加回去（復原用） */
  async restoreHost(h: Host): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO hosts (url, label, source, version, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [h.url, h.label, h.source, h.version, h.lastSeenAt, h.createdAt]
    );
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
      ? `AND (s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND ${VISIBLE} AND m.content LIKE ? ESCAPE '\\'))`
      : '';
    const params = q ? [likePattern(q), likePattern(q)] : [];
    const rows = await this.db.all<SessionRow & { preview: string | null }>(
      `SELECT s.*, ${PREVIEW} AS preview FROM sessions s WHERE s.deleted_at IS NULL ${where} ORDER BY s.updated_at DESC, s.created_at DESC`,
      params
    );
    return rows.map((r) => ({ ...toSession(r), preview: r.preview ?? '' }));
  }

  /** 最近刪除的對話，最近刪的在上面 */
  async listTrash(): Promise<(Session & { preview: string; deletedAt: number })[]> {
    const rows = await this.db.all<SessionRow & { preview: string | null; deleted_at: number }>(
      `SELECT s.*, ${PREVIEW} AS preview FROM sessions s WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC`
    );
    return rows.map((r) => ({ ...toSession(r), preview: r.preview ?? '', deletedAt: r.deleted_at }));
  }

  /** 移到最近刪除（30 天內可以復原） */
  async trashSessions(ids: string[]): Promise<void> {
    const now = this.now();
    for (const id of ids) await this.db.run('UPDATE sessions SET deleted_at = ? WHERE id = ?', [now, id]);
  }

  async restoreSessions(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.run('UPDATE sessions SET deleted_at = NULL WHERE id = ?', [id]);
  }

  /** 永久刪除（連訊息與照片） */
  async deleteSession(id: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
  }

  /** 清空最近刪除，之後壓縮檔案釋放空間 */
  async emptyTrash(): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE deleted_at IS NOT NULL');
    await this.db.exec('VACUUM');
  }

  /** 超過保留天數的刪除項目真正刪掉（開 App 時跑） */
  async purgeExpired(): Promise<void> {
    const cutoff = this.now() - TRASH_DAYS * DAY_MS;
    await this.db.run('DELETE FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
    await this.db.run('DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
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
      detail?: string;
      altGroup?: string | null;
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
      detail: m.detail ?? '',
      createdAt: now,
      attachments: (m.attachments ?? []).map((a) => ({ ...a, id: newId() })),
      versions: null,
      altGroup: m.altGroup ?? null,
    };
    await this.db.run(
      'INSERT INTO messages (id, session_id, seq, role, content, thinking, model, host_label, stats, detail, alt_group, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [msg.id, sessionId, seq, msg.role, msg.content, msg.thinking, msg.model, msg.hostLabel, msg.stats ? JSON.stringify(msg.stats) : null, msg.detail, msg.altGroup, now]
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
    const rows = await this.db.all<MessageRow>(`SELECT * FROM messages m WHERE session_id = ? AND ${VISIBLE} ORDER BY seq`, [sessionId]);
    const groupRows = await this.db.all<{ id: string; alt_group: string }>(
      'SELECT id, alt_group FROM messages WHERE session_id = ? AND alt_group IS NOT NULL AND deleted_at IS NULL ORDER BY seq',
      [sessionId]
    );
    const groups = new Map<string, string[]>();
    for (const g of groupRows) groups.set(g.alt_group, [...(groups.get(g.alt_group) ?? []), g.id]);
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
      detail: r.detail ?? '',
      createdAt: r.created_at,
      attachments: byMessage.get(r.id) ?? [],
      altGroup: r.alt_group ?? null,
      versions: (() => {
        const ids = r.alt_group ? (groups.get(r.alt_group) ?? []) : [];
        return ids.length > 1 ? { index: ids.indexOf(r.id) + 1, total: ids.length } : null;
      })(),
    }));
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE id = ?', [id]);
  }

  /** 刪掉某則訊息（含）之後的所有訊息（永久） */
  async deleteMessagesFrom(sessionId: string, seq: number): Promise<void> {
    await this.db.run('DELETE FROM messages WHERE session_id = ? AND seq >= ?', [sessionId, seq]);
  }

  /** 先藏起來（可以復原）：某則訊息（含）之後所有看得到的訊息。回傳被藏的訊息 id */
  async softDeleteFrom(sessionId: string, seq: number): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(`SELECT id FROM messages m WHERE session_id = ? AND seq >= ? AND ${VISIBLE}`, [sessionId, seq]);
    const ids = rows.map((r) => r.id);
    await this.softDeleteMessages(ids);
    return ids;
  }

  async softDeleteMessages(ids: string[]): Promise<void> {
    const now = this.now();
    for (const id of ids) await this.db.run('UPDATE messages SET deleted_at = ? WHERE id = ?', [now, id]);
  }

  async restoreMessages(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.run('UPDATE messages SET deleted_at = NULL WHERE id = ?', [id]);
  }

  /** 把回答收成「舊版本」（看不到，但可以切回來）。回傳版本群組代號 */
  async hideAsVersion(id: string): Promise<string> {
    await this.db.run('UPDATE messages SET alt_group = COALESCE(alt_group, id), hidden = 1 WHERE id = ?', [id]);
    return (await this.db.get<{ alt_group: string }>('SELECT alt_group FROM messages WHERE id = ?', [id]))!.alt_group;
  }

  /** 顯示同一群組裡的某個版本，其他版本藏起來 */
  async showVersion(id: string): Promise<void> {
    const row = await this.db.get<{ alt_group: string | null }>('SELECT alt_group FROM messages WHERE id = ?', [id]);
    if (!row?.alt_group) return;
    await this.db.run('UPDATE messages SET hidden = CASE WHEN id = ? THEN 0 ELSE 1 END WHERE alt_group = ?', [id, row.alt_group]);
  }

  /** 同一群組的版本 id（依先後） */
  async versionIds(group: string): Promise<string[]> {
    return (await this.db.all<{ id: string }>('SELECT id FROM messages WHERE alt_group = ? AND deleted_at IS NULL ORDER BY seq', [group])).map((r) => r.id);
  }

  // ---- 提示詞範本 ----

  async listTemplates(): Promise<Template[]> {
    return this.db.all<Template>('SELECT id, title, content, position FROM templates ORDER BY position, title');
  }

  /** 把範本原樣加回去（清除全部資料後復原用） */
  async restoreTemplate(tpl: Template): Promise<void> {
    await this.db.run('INSERT OR REPLACE INTO templates (id, title, content, position) VALUES (?, ?, ?, ?)', [tpl.id, tpl.title, tpl.content, tpl.position]);
  }

  // ---- 備份與還原 ----

  /**
   * 用另一個資料庫（備份檔）的內容取代目前全部的資料。
   * 備份檔先升級到目前的版本；不是這個 App 的備份就丟錯，目前的資料不會被動到。
   */
  async replaceWith(source: Db): Promise<void> {
    await assertBackup(source);
    await new Repo(source).migrate();
    await this.db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    try {
      for (const table of [...BACKUP_TABLES].reverse()) await this.db.run(`DELETE FROM ${table}`);
      for (const table of BACKUP_TABLES) {
        const rows = await source.all<Record<string, SqlValue>>(`SELECT * FROM ${table}`);
        for (const row of rows) {
          const cols = Object.keys(row);
          await this.db.run(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            cols.map((c) => row[c])
          );
        }
      }
      await this.db.exec('COMMIT; PRAGMA foreign_keys = ON;');
    } catch (e) {
      await this.db.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
      throw e;
    }
  }

  /** 把目前全部的資料複製到另一個（空的）資料庫 */
  async copyTo(target: Db): Promise<void> {
    const copy = new Repo(target, this.now);
    await copy.migrate();
    await copy.replaceWith(this.db);
  }

  // ---- 資料庫檔案 ----

  /** 所有（還沒刪除的）對話移到最近刪除，回傳它們的 id */
  async trashAllSessions(): Promise<string[]> {
    const ids = (await this.db.all<{ id: string }>('SELECT id FROM sessions WHERE deleted_at IS NULL')).map((r) => r.id);
    await this.trashSessions(ids);
    return ids;
  }

  /** 清除全部資料，回到第一次打開的樣子（範本恢復成預設）；永久刪除，之後壓縮檔案 */
  async resetAll(): Promise<void> {
    await this.db.exec('DELETE FROM sessions; DELETE FROM hosts; DELETE FROM templates; DELETE FROM settings;');
    await this.seedTemplates();
    await this.db.exec('VACUUM');
  }

  /** 清除前先記下主機、範本、設定，復原時放回去 */
  async snapshotSettings(): Promise<{ hosts: Host[]; templates: Template[]; settings: { key: string; value: string }[] }> {
    return {
      hosts: await this.listHosts(),
      templates: await this.listTemplates(),
      settings: await this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings'),
    };
  }

  async restoreSnapshot(snap: { hosts: Host[]; templates: Template[]; settings: { key: string; value: string }[] }): Promise<void> {
    await this.db.exec('DELETE FROM hosts; DELETE FROM templates; DELETE FROM settings;');
    for (const h of snap.hosts) await this.restoreHost(h);
    for (const tpl of snap.templates) await this.restoreTemplate(tpl);
    for (const s of snap.settings) await this.setSetting(s.key, s.value);
  }

  /** 清掉主機、範本、設定（範本恢復預設），對話另外處理 */
  async clearSettings(): Promise<void> {
    await this.db.exec('DELETE FROM hosts; DELETE FROM templates; DELETE FROM settings;');
    await this.seedTemplates();
  }

  private async seedTemplates(): Promise<void> {
    for (const [i, t] of defaultTemplates().entries()) {
      await this.db.run('INSERT INTO templates (id, title, content, position) VALUES (?, ?, ?, ?)', [newId(), t.title, t.content, i]);
    }
  }

  /** 對話有幾段 */
  async countSessions(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL'))?.n ?? 0;
  }

  async countTrash(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NOT NULL'))?.n ?? 0;
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
