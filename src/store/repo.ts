import type { ThinkSetting } from '../lib/ollama';
import type { ToolCall, ToolInput } from '../lib/tools';
import type { Db, SqlValue } from './db';
import { t } from '../i18n';

// ---- 型別 ----

export type Host = {
  url: string;
  label: string;
  /** helper：透過 Local AI 小幫手（配對過，權杖存在安全儲存區） */
  source: 'scan' | 'manual' | 'helper';
  /** 小幫手的識別碼（位址變了也認得出是同一台） */
  helperId: string | null;
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
  /** 討論串：掛在哪一段對話（一般對話是 null） */
  parentId: string | null;
  /** 討論串：從那段對話的哪一題（使用者的那則訊息）開的 */
  parentMessageId: string | null;
};

export type Attachment = { id: string; base64: string; width: number; height: number };

export type MessageStats = {
  evalCount: number;
  evalDurationNs: number;
  promptEvalCount: number;
  totalDurationNs: number;
};

/** tool：工具執行結果（content 交給模型，detail 是給使用者看的一句話） */
export type Role = 'user' | 'assistant' | 'error' | 'note' | 'tool';

/** 會改東西的工具動作：等使用者確認、做了什麼、怎麼復原 */
/** skipped：沒按確認卡就打了新訊息（跟按「不要」的 declined 分開，畫面說法不同） */
export type ActionStatus = 'pending' | 'declined' | 'skipped' | 'done' | 'failed' | 'undone';
export type Action = {
  id: string;
  sessionId: string;
  /** 叫這個工具的那則 AI 訊息 */
  messageId: string;
  callId: string;
  tool: string;
  input: ToolInput;
  /** 使用者沒說、由 App 補上的欄位（確認卡標淡色） */
  guessed: string[];
  status: ActionStatus;
  /** 執行結果（復原要用） */
  result: unknown;
  /** 給使用者看的一句話（例如「新增 1 個行程」） */
  summary: string;
  /** 拒絕的原因、失敗的原因；做了的話是使用者按「修改」改了哪些欄位（交給模型，畫面不顯示） */
  note: string;
  createdAt: number;
};

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
  /** 錯誤的技術細節（畫面上預設收起來）；工具結果給使用者看的一句話；提示行是 RECORD_NOTE 時表示只是紀錄 */
  detail: string;
  createdAt: number;
  attachments: Attachment[];
  /** 重新產生過的回答：目前是第幾個版本、一共幾個（沒有其他版本是 null） */
  versions: { index: number; total: number } | null;
  /** 同一題的不同回答版本共用這個代號 */
  altGroup: string | null;
  /** AI 這則訊息叫的工具 */
  toolCalls?: ToolCall[];
  /** 工具結果（role: tool）屬於哪個工具、哪一次呼叫 */
  toolName?: string;
  toolCallId?: string;
  /** 這則 AI 訊息叫出來、要使用者確認的動作 */
  actions?: Action[];
};

/** 「你按了復原」這種只是紀錄的提示行：不能「重新回答」，也不算最後一則（上面 AI 的回答照樣有複製、重新產生） */
export const RECORD_NOTE = 'record';
/** 討論串一開始帶進去的那一題（從原對話複製來的問與答）：只是背景，不能重新產生、編輯、刪除 */
export const THREAD_ROOT = 'thread-root';
export const isThreadRoot = (m: Pick<Message, 'detail'>) => m.detail === THREAD_ROOT;
export const isRecordNote = (m: Pick<Message, 'role' | 'detail'>) => m.role === 'note' && m.detail === RECORD_NOTE;


// ---- 資料表 ----

const SCHEMA_VERSION = 6;

/** 每一版要做的改變（舊版資料庫照順序補上） */
const MIGRATIONS: Record<number, string> = {
  2: "ALTER TABLE messages ADD COLUMN detail TEXT NOT NULL DEFAULT ''",
  // 刪除先放「最近刪除」（可以復原）；重新產生保留舊回答當版本
  3: `ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;
      ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
      ALTER TABLE messages ADD COLUMN alt_group TEXT;
      ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`,
  // 透過小幫手連線的電腦
  4: 'ALTER TABLE hosts ADD COLUMN helper_id TEXT',
  // 手機上動手做事：AI 叫的工具、工具結果、要使用者確認的動作
  5: `ALTER TABLE messages ADD COLUMN tool_calls TEXT;
      ALTER TABLE messages ADD COLUMN tool_name TEXT;
      ALTER TABLE messages ADD COLUMN tool_call_id TEXT;
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        guessed TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        result TEXT,
        summary TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS actions_by_session ON actions(session_id, created_at);`,
  // 討論串：針對某一題另開的小對話，掛在原本那段對話底下
  6: `ALTER TABLE sessions ADD COLUMN parent_id TEXT;
      ALTER TABLE sessions ADD COLUMN parent_message_id TEXT;
      CREATE INDEX IF NOT EXISTS sessions_by_parent ON sessions(parent_id);`,
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
/** 備份會帶走的資料表（照這個順序放回去，先放被參照的） */
const BACKUP_TABLES = ['hosts', 'sessions', 'messages', 'attachments', 'actions', 'templates', 'settings'] as const;

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
const PREVIEW = `(SELECT substr(m.content, 1, 80) FROM messages m WHERE m.session_id = s.id AND ${VISIBLE} AND m.role IN ('user', 'assistant') AND m.content != '' ORDER BY m.seq DESC LIMIT 1)`;
/** 對話裡還在等使用者確認的動作數（訊息被刪掉的不算） */
const PENDING = `(SELECT COUNT(*) FROM actions a JOIN messages m ON m.id = a.message_id WHERE a.session_id = s.id AND a.status = 'pending' AND ${VISIBLE})`;

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
  parent_id: string | null;
  parent_message_id: string | null;
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
  tool_calls: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: number;
};

type ActionRow = {
  id: string;
  session_id: string;
  message_id: string;
  call_id: string;
  tool: string;
  input: string;
  guessed: string;
  status: ActionStatus;
  result: string | null;
  summary: string;
  note: string;
  created_at: number;
};

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const toAction = (r: ActionRow): Action => ({
  id: r.id,
  sessionId: r.session_id,
  messageId: r.message_id,
  callId: r.call_id,
  tool: r.tool,
  input: parseJson<ToolInput>(r.input, {}),
  guessed: parseJson<string[]>(r.guessed, []),
  status: r.status,
  result: parseJson<unknown>(r.result, null),
  summary: r.summary,
  note: r.note,
  createdAt: r.created_at,
});

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  title: r.title,
  hostUrl: r.host_url,
  model: r.model,
  think: decodeThink(r.think),
  systemPrompt: r.system_prompt,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  parentId: r.parent_id ?? null,
  parentMessageId: r.parent_message_id ?? null,
});

export class Repo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  /** 建表、升級資料表 */
  async migrate(): Promise<void> {
    const row = await this.db.get<{ user_version: number }>('PRAGMA user_version');
    const version = row?.user_version ?? 0;
    if (version >= SCHEMA_VERSION) return;
    if (version === 0) {
      await this.db.exec(BASE_SCHEMA);
    }
    for (let v = Math.max(version, 1) + 1; v <= SCHEMA_VERSION; v++) await this.db.exec(MIGRATIONS[v]);
    await this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // ---- 主機 ----

  /** 新增或更新主機；手動加的不會被掃描結果改成 scan */
  async saveHost(host: { url: string; label: string; source: Host['source']; version?: string; helperId?: string | null }): Promise<void> {
    const now = this.now();
    await this.db.run(
      `INSERT INTO hosts (url, label, source, version, last_seen_at, created_at, helper_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         label = CASE WHEN hosts.source = 'manual' AND excluded.source = 'scan' THEN hosts.label ELSE excluded.label END,
         source = CASE WHEN excluded.source = 'helper' THEN 'helper' WHEN hosts.source = 'manual' THEN 'manual' ELSE excluded.source END,
         version = CASE WHEN excluded.version = '' THEN hosts.version ELSE excluded.version END,
         last_seen_at = COALESCE(excluded.last_seen_at, hosts.last_seen_at),
         helper_id = COALESCE(excluded.helper_id, hosts.helper_id)`,
      [host.url, host.label, host.source, host.version ?? '', host.version ? now : null, now, host.helperId ?? null]
    );
  }

  /** 小幫手換了位址：電腦紀錄和用到它的對話都改成新位址 */
  async moveHost(from: string, to: string): Promise<void> {
    if (from === to) return;
    await this.db.exec('BEGIN');
    try {
      await this.db.run('DELETE FROM hosts WHERE url = ?', [to]);
      await this.db.run('UPDATE hosts SET url = ? WHERE url = ?', [to, from]);
      await this.db.run('UPDATE sessions SET host_url = ? WHERE host_url = ?', [to, from]);
      await this.db.exec('COMMIT');
    } catch (e) {
      await this.db.exec('ROLLBACK');
      throw e;
    }
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
      helperId: r.helper_id ?? null,
      version: r.version,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    }));
  }

  /** 把移除的電腦原樣加回去（復原用） */
  async restoreHost(h: Host): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO hosts (url, label, source, version, last_seen_at, created_at, helper_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [h.url, h.label, h.source, h.version, h.lastSeenAt, h.createdAt, h.helperId]
    );
  }

  async removeHost(url: string): Promise<void> {
    await this.db.run('DELETE FROM hosts WHERE url = ?', [url]);
  }

  // ---- 對話 ----

  async createSession(
    init: { hostUrl?: string | null; model?: string | null; think?: ThinkSetting | null; systemPrompt?: string; title?: string; parentId?: string; parentMessageId?: string } = {}
  ): Promise<Session> {
    const now = this.now();
    const s: Session = {
      id: newId(),
      title: init.title ?? '',
      hostUrl: init.hostUrl ?? null,
      model: init.model ?? null,
      think: init.think ?? null,
      systemPrompt: init.systemPrompt ?? '',
      createdAt: now,
      updatedAt: now,
      parentId: init.parentId ?? null,
      parentMessageId: init.parentMessageId ?? null,
    };
    await this.db.run(
      'INSERT INTO sessions (id, title, host_url, model, think, system_prompt, created_at, updated_at, parent_id, parent_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [s.id, s.title, s.hostUrl, s.model, encodeThink(s.think), s.systemPrompt, s.createdAt, s.updatedAt, s.parentId, s.parentMessageId]
    );
    return s;
  }

  /** 某一題的討論串（還沒刪的） */
  async findThread(parentId: string, parentMessageId: string): Promise<Session | null> {
    const row = await this.db.get<SessionRow>('SELECT * FROM sessions WHERE parent_id = ? AND parent_message_id = ? AND deleted_at IS NULL', [parentId, parentMessageId]);
    return row ? toSession(row) : null;
  }

  /** 這段對話的討論串：掛在哪一題、裡面問了幾次（不算帶進去的那一題） */
  async threadsOf(parentId: string): Promise<{ id: string; parentMessageId: string; count: number }[]> {
    const rows = await this.db.all<{ id: string; parent_message_id: string; n: number }>(
      `SELECT s.id, s.parent_message_id, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND ${VISIBLE} AND m.role = 'user' AND m.detail != '${THREAD_ROOT}') AS n
       FROM sessions s WHERE s.parent_id = ? AND s.deleted_at IS NULL`,
      [parentId]
    );
    return rows.map((r) => ({ id: r.id, parentMessageId: r.parent_message_id, count: Number(r.n) }));
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
  async listSessions(search = ''): Promise<(Session & { preview: string; pending: number })[]> {
    const q = search.trim();
    // 討論串不另外列出；搜尋時討論串裡的字也算它那段對話的
    const where = q
      ? `AND (s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND ${VISIBLE} AND m.content LIKE ? ESCAPE '\\')
           OR EXISTS (SELECT 1 FROM sessions t JOIN messages m ON m.session_id = t.id WHERE t.parent_id = s.id AND t.deleted_at IS NULL AND ${VISIBLE} AND m.content LIKE ? ESCAPE '\\'))`
      : '';
    const params = q ? [likePattern(q), likePattern(q), likePattern(q)] : [];
    const rows = await this.db.all<SessionRow & { preview: string | null; pending: number }>(
      `SELECT s.*, ${PREVIEW} AS preview, ${PENDING} AS pending FROM sessions s WHERE s.deleted_at IS NULL AND s.parent_id IS NULL ${where} ORDER BY s.updated_at DESC, s.created_at DESC`,
      params
    );
    return rows.map((r) => ({ ...toSession(r), preview: r.preview ?? '', pending: Number(r.pending ?? 0) }));
  }

  /** 最近刪除的對話，最近刪的在上面 */
  async listTrash(): Promise<(Session & { preview: string; deletedAt: number })[]> {
    const rows = await this.db.all<SessionRow & { preview: string | null; deleted_at: number }>(
      `SELECT s.*, ${PREVIEW} AS preview FROM sessions s WHERE s.deleted_at IS NOT NULL AND s.parent_id IS NULL ORDER BY s.deleted_at DESC`
    );
    return rows.map((r) => ({ ...toSession(r), preview: r.preview ?? '', deletedAt: r.deleted_at }));
  }

  /** 移到最近刪除（30 天內可以復原）；它的討論串一起 */
  async trashSessions(ids: string[]): Promise<void> {
    const now = this.now();
    for (const id of ids) await this.db.run('UPDATE sessions SET deleted_at = ? WHERE id = ? OR parent_id = ?', [now, id, id]);
  }

  async restoreSessions(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.run('UPDATE sessions SET deleted_at = NULL WHERE id = ? OR parent_id = ?', [id, id]);
  }

  /** 永久刪除（連訊息與照片、它的討論串） */
  async deleteSession(id: string): Promise<void> {
    await this.db.run('DELETE FROM sessions WHERE id = ? OR parent_id = ?', [id, id]);
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
    // 開討論串的那一題已經真的刪掉了：討論串再也點不到，一起刪
    await this.db.run('DELETE FROM sessions WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = sessions.parent_message_id)');
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
      toolCalls?: ToolCall[];
      toolName?: string;
      toolCallId?: string;
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
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    };
    await this.db.run(
      'INSERT INTO messages (id, session_id, seq, role, content, thinking, model, host_label, stats, detail, alt_group, tool_calls, tool_name, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        msg.id,
        sessionId,
        seq,
        msg.role,
        msg.content,
        msg.thinking,
        msg.model,
        msg.hostLabel,
        msg.stats ? JSON.stringify(msg.stats) : null,
        msg.detail,
        msg.altGroup,
        m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
        m.toolName ?? null,
        m.toolCallId ?? null,
        now,
      ]
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
    // 討論串裡有新訊息：它那段對話也算有新動靜（清單裡排到上面）
    await this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ? OR id = (SELECT parent_id FROM sessions WHERE id = ?)', [now, sessionId, sessionId]);
    return msg;
  }

  /** 回答串流結束後把完整內容與統計寫回去 */
  async updateMessage(id: string, patch: { content?: string; thinking?: string; stats?: MessageStats | null; role?: Role; toolCalls?: ToolCall[] }): Promise<void> {
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
    if (patch.toolCalls !== undefined) {
      sets.push('tool_calls = ?');
      params.push(patch.toolCalls.length ? JSON.stringify(patch.toolCalls) : null);
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
    const actionRows = await this.db.all<ActionRow>('SELECT * FROM actions WHERE session_id = ? ORDER BY created_at, rowid', [sessionId]);
    const actionsByMessage = new Map<string, Action[]>();
    for (const a of actionRows) actionsByMessage.set(a.message_id, [...(actionsByMessage.get(a.message_id) ?? []), toAction(a)]);
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
      ...(r.tool_calls ? { toolCalls: parseJson<ToolCall[]>(r.tool_calls, []) } : {}),
      ...(r.tool_name ? { toolName: r.tool_name } : {}),
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
      ...(actionsByMessage.has(r.id) ? { actions: actionsByMessage.get(r.id) } : {}),
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

  // ---- 動作（要使用者確認的工具呼叫） ----

  async addAction(a: Omit<Action, 'id' | 'createdAt' | 'result' | 'summary' | 'note'> & Partial<Pick<Action, 'summary' | 'note'>>): Promise<Action> {
    const now = this.now();
    const action: Action = { ...a, id: newId(), result: null, summary: a.summary ?? '', note: a.note ?? '', createdAt: now };
    await this.db.run(
      'INSERT INTO actions (id, session_id, message_id, call_id, tool, input, guessed, status, result, summary, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [action.id, a.sessionId, a.messageId, a.callId, a.tool, JSON.stringify(a.input), JSON.stringify(a.guessed), a.status, null, action.summary, action.note, now, now]
    );
    return action;
  }

  async getAction(id: string): Promise<Action | null> {
    const row = await this.db.get<ActionRow>('SELECT * FROM actions WHERE id = ?', [id]);
    return row ? toAction(row) : null;
  }

  async updateAction(id: string, patch: Partial<Pick<Action, 'status' | 'input' | 'result' | 'summary' | 'note'>>): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [this.now()];
    if (patch.status !== undefined) (sets.push('status = ?'), params.push(patch.status));
    if (patch.input !== undefined) (sets.push('input = ?'), params.push(JSON.stringify(patch.input)));
    if (patch.result !== undefined) (sets.push('result = ?'), params.push(JSON.stringify(patch.result)));
    if (patch.summary !== undefined) (sets.push('summary = ?'), params.push(patch.summary));
    if (patch.note !== undefined) (sets.push('note = ?'), params.push(patch.note));
    await this.db.run(`UPDATE actions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  }

  /** 做過的事（設定頁的清單）：最近的在上面 */
  async listDoneActions(limit = 100): Promise<Action[]> {
    const rows = await this.db.all<ActionRow>("SELECT * FROM actions WHERE status IN ('done', 'undone') ORDER BY created_at DESC LIMIT ?", [limit]);
    return rows.map(toAction);
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

  /**
   * 清除全部資料的最後一步：這些對話還在最近刪除的才永久刪掉（可以復原的那幾秒內救回的、之後新開的都留著），
   * 電腦、設定全刪，之後壓縮檔案
   */
  async wipe(sessionIds: string[]): Promise<void> {
    const trashed = new Set((await this.db.all<{ id: string }>('SELECT id FROM sessions WHERE deleted_at IS NOT NULL')).map((r) => r.id));
    for (const id of sessionIds) if (trashed.has(id)) await this.deleteSession(id);
    await this.clearSettings();
    await this.db.exec('VACUUM');
  }

  /** 清除前先記下主機、設定，復原時放回去 */
  async snapshotSettings(): Promise<{ hosts: Host[]; settings: { key: string; value: string }[] }> {
    return {
      hosts: await this.listHosts(),
      settings: await this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings'),
    };
  }

  async restoreSnapshot(snap: { hosts: Host[]; settings: { key: string; value: string }[] }): Promise<void> {
    await this.db.exec('DELETE FROM hosts; DELETE FROM settings;');
    for (const h of snap.hosts) await this.restoreHost(h);
    for (const s of snap.settings) await this.setSetting(s.key, s.value);
  }

  /** 清掉主機、設定，對話另外處理 */
  async clearSettings(): Promise<void> {
    await this.db.exec('DELETE FROM hosts; DELETE FROM templates; DELETE FROM settings;');
  }

  /** 對話有幾段 */
  async countSessions(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL AND parent_id IS NULL'))?.n ?? 0;
  }

  async countTrash(): Promise<number> {
    return (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NOT NULL AND parent_id IS NULL'))?.n ?? 0;
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
