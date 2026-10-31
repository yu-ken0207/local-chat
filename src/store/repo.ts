import type { ThinkSetting } from '../lib/ollama';
import type { ToolCall, ToolInput } from '../lib/tools';
import type { Db, SqlValue } from './db';
import { getEntry, localizeIntro, localizeName } from '../agents/catalog';
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
  /** 多 AI 討論的設定（null：照預設） */
  group: GroupSettings | null;
  /** 前情摘要：第 summarySeq 則（含）以前的內容 */
  summary: string;
  summarySeq: number;
  /** 釘在最上面的結論卡（訊息 id） */
  pinnedId: string | null;
};

/** 多 AI 討論的發言方式：自由搶話、主持人點名、輪流、只回被 @ 的 */
export type SpeakMode = 'free' | 'host' | 'round' | 'mention';
export type GroupSettings = {
  mode: SpeakMode;
  /** 讓「我的 Agent」裡勾了「可以自己加入」的也舉手 */
  autoJoin: boolean;
  /** 你每說一句，AI 最多連續講幾則 */
  maxStreak: number;
  /** 全自動：不等你，聊到沒人想講或到上限就自己收尾 */
  autopilot: boolean;
};
export const DEFAULT_GROUP: GroupSettings = { mode: 'free', autoJoin: false, maxStreak: 12, autopilot: false };

/** 自己建的 Agent 的角色卡（AI 從一句話生成，可以改） */
export type AgentCard = { expertise: string; stance: string; style: string; blindSpot: string };

export type Agent = {
  id: string;
  /** 從圖鑑來的：圖鑑裡的 id（自己建的是 null） */
  catalogId: string | null;
  name: string;
  intro: string;
  /** 角色原文；null 表示照圖鑑原文（跟著 App 語言） */
  prompt: string | null;
  card: AgentCard | null;
  emoji: string;
  /** 用哪個圖鑑角色的像素頭像（null：自己的圖鑑 id，再沒有就用 emoji） */
  avatar: string | null;
  /** 相簿選的照片（base64） */
  photo: string | null;
  /** 積極度 0–1：影響舉手分數 */
  talk: number;
  /** 指定的電腦與模型（null：跟著對話） */
  hostUrl: string | null;
  model: string | null;
  /** 「讓 AI 自己加入」的對話裡會舉手 */
  autoJoin: boolean;
  /** 放在「我的 Agent」 */
  mine: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

/** 怎麼加入討論的：你加的、AI 自己加入、被 @ 拉進來、跟著原對話進討論串 */
export type JoinedBy = 'user' | 'auto' | 'mention' | 'thread';
export type Member = { agent: Agent; position: number; joinedBy: JoinedBy; joinedAt: number };

/** 問模型做什麼：回答、Agent 發言、舉手、主持人點名、前情摘要、收尾（列方案、投票、結論、筆記）、取標題、找 Agent、一句話生成角色 */
export type UsageKind = 'answer' | 'speak' | 'bid' | 'host' | 'summary' | 'conclude' | 'title' | 'find' | 'draft';
export type UsageEntry = {
  at: number;
  sessionId: string | null;
  agentId: string | null;
  kind: UsageKind;
  hostUrl: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  totalMs: number;
  evalMs: number;
  /** 回答、發言當時模型能記住多少 tokens（背景工作不記） */
  contextLimit?: number | null;
};
/** 一段時間的用量（依電腦、模型加總） */
export type UsageTotals = {
  calls: number;
  promptTokens: number;
  outputTokens: number;
  totalMs: number;
  evalMs: number;
  /** 回答、發言以外（舉手、摘要、收尾、取標題、找 Agent…）的呼叫用掉的 token */
  backgroundTokens: number;
  byModel: { hostUrl: string; model: string; calls: number; promptTokens: number; outputTokens: number; totalMs: number; evalMs: number }[];
};
/** session_members 的一列（刪掉 Agent 時記下來，復原時放回去） */
export type MemberRow = { session_id: string; agent_id: string; position: number; joined_by: JoinedBy; joined_at: number };

/** Agent 的筆記：收尾後寫下這次的立場與學到的事，下次討論帶著 */
export type AgentNote = { id: string; agentId: string; sessionId: string | null; content: string; createdAt: number };

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
  /** 多 AI 討論：哪個 Agent 說的（使用者、一對一的 AI 是 null） */
  agentId: string | null;
  /** 回哪一則 */
  replyTo: string | null;
};

/** 「你按了復原」這種只是紀錄的提示行：不能「重新回答」，也不算最後一則（上面 AI 的回答照樣有複製、重新產生） */
export const RECORD_NOTE = 'record';
/** 討論串一開始帶進去的那一題（從原對話複製來的問與答）：只是背景，不能重新產生、編輯、刪除 */
export const THREAD_ROOT = 'thread-root';
export const isThreadRoot = (m: Pick<Message, 'detail'>) => m.detail === THREAD_ROOT;
export const isRecordNote = (m: Pick<Message, 'role' | 'detail'>) => m.role === 'note' && m.detail === RECORD_NOTE;


// ---- 資料表 ----

const SCHEMA_VERSION = 10;

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
  // 多 AI 討論：Agent、對話成員、Agent 的筆記；對話的群組設定與前情摘要；訊息是誰說的、回哪則
  7: `CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        catalog_id TEXT,
        name TEXT NOT NULL,
        intro TEXT NOT NULL DEFAULT '',
        prompt TEXT,
        card TEXT,
        emoji TEXT NOT NULL DEFAULT '',
        avatar TEXT,
        photo TEXT,
        talk REAL NOT NULL DEFAULT 0.5,
        host_url TEXT,
        model TEXT,
        auto_join INTEGER NOT NULL DEFAULT 0,
        mine INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agents_by_catalog ON agents(catalog_id) WHERE catalog_id IS NOT NULL AND deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS session_members (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        joined_by TEXT NOT NULL DEFAULT 'user',
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agent_notes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_notes_by_agent ON agent_notes(agent_id, created_at);
      ALTER TABLE sessions ADD COLUMN group_settings TEXT;
      ALTER TABLE sessions ADD COLUMN summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN summary_seq INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sessions ADD COLUMN pinned_id TEXT;
      ALTER TABLE messages ADD COLUMN agent_id TEXT;
      ALTER TABLE messages ADD COLUMN reply_to TEXT;`,
  // 從圖鑑來的 Agent：名字、介紹有沒有改過（沒改過的跟著 App 語言；舊資料一律當沒改過）
  8: `ALTER TABLE agents ADD COLUMN name_custom INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agents ADD COLUMN intro_custom INTEGER NOT NULL DEFAULT 0;`,
  // 用量紀錄：每次問模型記一筆（只有數字，沒有內容）；對話刪掉也留著，算累計用
  9: `CREATE TABLE IF NOT EXISTS usage_log (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        kind TEXT NOT NULL,
        host_url TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        eval_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_by_time ON usage_log(at);
      CREATE INDEX IF NOT EXISTS usage_by_session ON usage_log(session_id, at);`,
  // 回答、發言當時模型能記住多少（模型閒置卸載後，儀表照樣用這個上限，不會改用模型的最大值）
  10: `ALTER TABLE usage_log ADD COLUMN context_limit INTEGER;`,
};

/** 用量紀錄保留幾天 */
export const USAGE_DAYS = 90;

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

/** 清除全部資料前記下來的東西（復原用） */
export type Snapshot = {
  hosts: Host[];
  settings: { key: string; value: string }[];
  agents: Record<string, SqlValue>[];
  notes: Record<string, SqlValue>[];
};

/** 備份會帶走的資料表（照這個順序放回去，先放被參照的） */
const BACKUP_TABLES = ['hosts', 'sessions', 'agents', 'session_members', 'messages', 'attachments', 'actions', 'agent_notes', 'templates', 'settings', 'usage_log'] as const;

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
  group_settings: string | null;
  summary: string | null;
  summary_seq: number | null;
  pinned_id: string | null;
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
  agent_id: string | null;
  reply_to: string | null;
  created_at: number;
};

type AgentRow = {
  id: string;
  catalog_id: string | null;
  name: string;
  intro: string;
  prompt: string | null;
  card: string | null;
  emoji: string;
  avatar: string | null;
  photo: string | null;
  talk: number;
  host_url: string | null;
  model: string | null;
  auto_join: number;
  mine: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  name_custom: number;
  intro_custom: number;
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
  group: r.group_settings ? { ...DEFAULT_GROUP, ...parseJson<Partial<GroupSettings>>(r.group_settings, {}) } : null,
  summary: r.summary ?? '',
  summarySeq: r.summary_seq ?? 0,
  pinnedId: r.pinned_id ?? null,
});

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  catalogId: r.catalog_id,
  // 從圖鑑來、沒改過的：跟著 App 語言
  name: r.name_custom ? r.name : localizeName(r.catalog_id, r.name),
  intro: r.intro_custom ? r.intro : localizeIntro(r.catalog_id, r.intro),
  prompt: r.prompt,
  card: parseJson<AgentCard | null>(r.card, null),
  emoji: r.emoji,
  avatar: r.avatar,
  photo: r.photo,
  talk: r.talk,
  hostUrl: r.host_url,
  model: r.model,
  autoJoin: r.auto_join === 1,
  mine: r.mine === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
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
    // 每一版連同版本號包在同一個交易裡：升級到一半被中斷，下次從那一版整個重來（不會卡在「欄位已經有了」）
    const step = async (sql: string, v: number) => {
      try {
        await this.db.exec(`BEGIN;\n${sql.trim().replace(/;$/, '')};\nPRAGMA user_version = ${v};\nCOMMIT;`);
      } catch (e) {
        await this.db.exec('ROLLBACK').catch(() => {});
        throw e;
      }
    };
    if (version === 0) await step(BASE_SCHEMA, 1);
    for (let v = Math.max(version, 1) + 1; v <= SCHEMA_VERSION; v++) await step(MIGRATIONS[v], v);
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
    init: {
      hostUrl?: string | null;
      model?: string | null;
      think?: ThinkSetting | null;
      systemPrompt?: string;
      title?: string;
      parentId?: string;
      parentMessageId?: string;
      group?: GroupSettings | null;
    } = {}
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
      group: init.group ?? null,
      summary: '',
      summarySeq: 0,
      pinnedId: null,
    };
    await this.db.run(
      'INSERT INTO sessions (id, title, host_url, model, think, system_prompt, created_at, updated_at, parent_id, parent_message_id, group_settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [s.id, s.title, s.hostUrl, s.model, encodeThink(s.think), s.systemPrompt, s.createdAt, s.updatedAt, s.parentId, s.parentMessageId, s.group ? JSON.stringify(s.group) : null]
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

  /** 對話還在（沒有被刪、也沒有在最近刪除裡） */
  async isActive(id: string): Promise<boolean> {
    return !!(await this.db.get('SELECT 1 FROM sessions WHERE id = ? AND deleted_at IS NULL', [id]));
  }

  async getSession(id: string): Promise<Session | null> {
    const row = await this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id]);
    return row ? toSession(row) : null;
  }

  /** 改對話設定（標題、主機、模型、思考、角色）；不會改「最後更新時間」，免得只是換模型就跳到清單最上面 */
  async updateSession(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'hostUrl' | 'model' | 'think' | 'systemPrompt' | 'group' | 'summary' | 'summarySeq' | 'pinnedId'>>
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
    if (patch.group !== undefined) add('group_settings', patch.group ? JSON.stringify(patch.group) : null);
    if (patch.summary !== undefined) add('summary', patch.summary);
    if (patch.summarySeq !== undefined) add('summary_seq', patch.summarySeq);
    if (patch.pinnedId !== undefined) add('pinned_id', patch.pinnedId);
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
    await this.purgeUnusedAgents(cutoff);
    await this.db.run('DELETE FROM usage_log WHERE at < ?', [this.now() - USAGE_DAYS * DAY_MS]);
  }

  // ---- 用量紀錄 ----

  async addUsage(u: UsageEntry): Promise<void> {
    await this.db.run(
      'INSERT INTO usage_log (id, at, session_id, agent_id, kind, host_url, model, prompt_tokens, output_tokens, total_ms, eval_ms, context_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), u.at, u.sessionId, u.agentId, u.kind, u.hostUrl, u.model, Math.round(u.promptTokens), Math.round(u.outputTokens), Math.round(u.totalMs), Math.round(u.evalMs), u.contextLimit ?? null]
    );
  }

  /** 這段對話最後一次回答或發言（算上下文用了多少） */
  async lastUsage(sessionId: string): Promise<UsageEntry | null> {
    const r = await this.db.get<Record<string, SqlValue>>(
      "SELECT * FROM usage_log WHERE session_id = ? AND kind IN ('answer', 'speak') ORDER BY at DESC, rowid DESC LIMIT 1",
      [sessionId]
    );
    return r
      ? {
          at: Number(r.at),
          sessionId: (r.session_id as string) ?? null,
          agentId: (r.agent_id as string) ?? null,
          kind: r.kind as UsageKind,
          hostUrl: String(r.host_url),
          model: String(r.model),
          promptTokens: Number(r.prompt_tokens),
          outputTokens: Number(r.output_tokens),
          totalMs: Number(r.total_ms),
          evalMs: Number(r.eval_ms),
          contextLimit: r.context_limit == null ? null : Number(r.context_limit),
        }
      : null;
  }

  /** 這段對話最後一次某種呼叫是什麼時候（例如整理成摘要） */
  async lastUsageAt(sessionId: string, kind: UsageKind): Promise<number | null> {
    const r = await this.db.get<{ at: number | null }>('SELECT MAX(at) AS at FROM usage_log WHERE session_id = ? AND kind = ?', [sessionId, kind]);
    return r?.at ?? null;
  }

  /** 這台電腦的這個模型上次回答時能記住多少（模型卸載了、還沒問過時用） */
  async lastContextLimit(hostUrl: string, model: string): Promise<number | null> {
    const r = await this.db.get<{ n: number }>(
      'SELECT context_limit AS n FROM usage_log WHERE host_url = ? AND model = ? AND context_limit IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1',
      [hostUrl, model]
    );
    return r ? Number(r.n) : null;
  }

  /** since 之後的用量，依電腦、模型加總（用得多的在前面） */
  async usageTotals(since: number): Promise<UsageTotals> {
    const rows = await this.db.all<{ host_url: string; model: string; calls: number; p: number; o: number; t: number; e: number }>(
      `SELECT host_url, model, COUNT(*) AS calls, SUM(prompt_tokens) AS p, SUM(output_tokens) AS o, SUM(total_ms) AS t, SUM(eval_ms) AS e
       FROM usage_log WHERE at >= ? GROUP BY host_url, model ORDER BY SUM(prompt_tokens) + SUM(output_tokens) DESC`,
      [since]
    );
    const bg = await this.db.get<{ n: number | null }>(
      "SELECT SUM(prompt_tokens) + SUM(output_tokens) AS n FROM usage_log WHERE at >= ? AND kind NOT IN ('answer', 'speak')",
      [since]
    );
    const byModel = rows.map((r) => ({ hostUrl: r.host_url, model: r.model, calls: r.calls, promptTokens: r.p ?? 0, outputTokens: r.o ?? 0, totalMs: r.t ?? 0, evalMs: r.e ?? 0 }));
    const sum = (k: 'calls' | 'promptTokens' | 'outputTokens' | 'totalMs' | 'evalMs') => byModel.reduce((n, x) => n + x[k], 0);
    return { calls: sum('calls'), promptTokens: sum('promptTokens'), outputTokens: sum('outputTokens'), totalMs: sum('totalMs'), evalMs: sum('evalMs'), backgroundTokens: bg?.n ?? 0, byModel };
  }

  /** 刪掉的 Agent：沒有任何對話、訊息還用到它就真的刪掉（before 之前刪的才算） */
  private async purgeUnusedAgents(before: number): Promise<void> {
    await this.db.run(
      `DELETE FROM agents WHERE deleted_at IS NOT NULL AND deleted_at <= ?
         AND NOT EXISTS (SELECT 1 FROM session_members m WHERE m.agent_id = agents.id)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.agent_id = agents.id)`,
      [before]
    );
  }

  /** 刪掉沒有任何訊息的空白對話（開了新對話卻沒講話）；已經加了成員、改過群組設定的留著 */
  async deleteEmptySessions(exceptId?: string): Promise<void> {
    await this.db.run(
      `DELETE FROM sessions WHERE id != ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)
         AND NOT EXISTS (SELECT 1 FROM session_members sm WHERE sm.session_id = sessions.id) AND group_settings IS NULL`,
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
      agentId?: string | null;
      replyTo?: string | null;
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
      agentId: m.agentId ?? null,
      replyTo: m.replyTo ?? null,
    };
    await this.db.run(
      'INSERT INTO messages (id, session_id, seq, role, content, thinking, model, host_label, stats, detail, alt_group, tool_calls, tool_name, tool_call_id, agent_id, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        msg.agentId,
        msg.replyTo,
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
      agentId: r.agent_id ?? null,
      replyTo: r.reply_to ?? null,
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

  // ---- Agent（多 AI 討論） ----

  /** 自己建的或從圖鑑加進來的 Agent */
  async createAgent(
    init: Pick<Agent, 'name'> & Partial<Omit<Agent, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'deletedAt'>>
  ): Promise<Agent> {
    const now = this.now();
    const a: Agent = {
      id: newId(),
      catalogId: init.catalogId ?? null,
      name: init.name,
      intro: init.intro ?? '',
      prompt: init.prompt ?? null,
      card: init.card ?? null,
      emoji: init.emoji ?? '',
      avatar: init.avatar ?? null,
      photo: init.photo ?? null,
      talk: init.talk ?? 0.5,
      hostUrl: init.hostUrl ?? null,
      model: init.model ?? null,
      autoJoin: init.autoJoin ?? false,
      mine: init.mine ?? false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    // 從圖鑑來、名字介紹跟圖鑑不一樣的：一開始就算改過（不跟著語言換）
    const e = a.catalogId ? getEntry(a.catalogId) : undefined;
    const nameCustom = e && !e.n.includes(a.name) ? 1 : 0;
    const introCustom = e && !e.d.includes(a.intro) ? 1 : 0;
    await this.db.run(
      `INSERT INTO agents (id, catalog_id, name, intro, prompt, card, emoji, avatar, photo, talk, host_url, model, auto_join, mine, created_at, updated_at, name_custom, intro_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [a.id, a.catalogId, a.name, a.intro, a.prompt, a.card ? JSON.stringify(a.card) : null, a.emoji, a.avatar, a.photo, a.talk, a.hostUrl, a.model, a.autoJoin ? 1 : 0, a.mine ? 1 : 0, now, now, nameCustom, introCustom]
    );
    return { ...a, name: nameCustom ? a.name : localizeName(a.catalogId, a.name), intro: introCustom ? a.intro : localizeIntro(a.catalogId, a.intro) };
  }

  /**
   * 圖鑑裡的某個 Agent：用過就沿用同一份（筆記才接得上）；刪掉過的救回那一份；沒用過才新建。
   * 連點兩下同時加：後到的撞到唯一索引就拿先建好的那份
   */
  async agentFromCatalog(catalogId: string, fields: Pick<Agent, 'name' | 'intro' | 'emoji'>): Promise<Agent> {
    const active = () => this.db.get<AgentRow>('SELECT * FROM agents WHERE catalog_id = ? AND deleted_at IS NULL', [catalogId]);
    const row = await active();
    if (row) return toAgent(row);
    const old = await this.db.get<{ id: string }>('SELECT id FROM agents WHERE catalog_id = ? ORDER BY deleted_at DESC LIMIT 1', [catalogId]);
    if (old) {
      await this.db.run('UPDATE OR IGNORE agents SET deleted_at = NULL, updated_at = ? WHERE id = ?', [this.now(), old.id]);
      return toAgent((await active())!);
    }
    try {
      return await this.createAgent({ ...fields, catalogId });
    } catch (e) {
      const again = await active();
      if (again) return toAgent(again);
      throw e;
    }
  }

  async getAgent(id: string): Promise<Agent | null> {
    const row = await this.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', [id]);
    return row ? toAgent(row) : null;
  }

  /** 一次拿好幾個（訊息上要顯示名字、頭像；刪掉的也拿得到） */
  async agentsByIds(ids: string[]): Promise<Agent[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.all<AgentRow>(`SELECT * FROM agents WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
    return rows.map(toAgent);
  }

  /** 「我的 Agent」：最近改過的在上面 */
  async listMyAgents(): Promise<Agent[]> {
    const rows = await this.db.all<AgentRow>('SELECT * FROM agents WHERE mine = 1 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC');
    return rows.map(toAgent);
  }

  async updateAgent(
    id: string,
    patch: Partial<Pick<Agent, 'name' | 'intro' | 'prompt' | 'card' | 'emoji' | 'avatar' | 'photo' | 'talk' | 'hostUrl' | 'model' | 'autoJoin' | 'mine'>>
  ): Promise<void> {
    const cols: Record<string, SqlValue> = {};
    // 名字、介紹真的改了才記「改過」（編輯畫面整張存回來，沒動的那欄不算）
    const cur = patch.name !== undefined || patch.intro !== undefined ? await this.getAgent(id) : null;
    if (patch.name !== undefined && patch.name.trim() !== cur?.name.trim()) (cols.name = patch.name), (cols.name_custom = 1);
    if (patch.intro !== undefined && patch.intro.trim() !== cur?.intro.trim()) (cols.intro = patch.intro), (cols.intro_custom = 1);
    if (patch.prompt !== undefined) cols.prompt = patch.prompt;
    if (patch.card !== undefined) cols.card = patch.card ? JSON.stringify(patch.card) : null;
    if (patch.emoji !== undefined) cols.emoji = patch.emoji;
    if (patch.avatar !== undefined) cols.avatar = patch.avatar;
    if (patch.photo !== undefined) cols.photo = patch.photo;
    if (patch.talk !== undefined) cols.talk = Math.min(1, Math.max(0, patch.talk));
    if (patch.hostUrl !== undefined) cols.host_url = patch.hostUrl;
    if (patch.model !== undefined) cols.model = patch.model;
    if (patch.autoJoin !== undefined) cols.auto_join = patch.autoJoin ? 1 : 0;
    if (patch.mine !== undefined) cols.mine = patch.mine ? 1 : 0;
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    await this.db.run(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => cols[k]), this.now(), id]);
  }

  /**
   * 刪掉 Agent：先藏起來（說過的話照樣看得到名字、頭像），也退出所有對話（不再發言）。
   * 回傳退出的成員紀錄，復原時放回去
   */
  async deleteAgent(id: string): Promise<MemberRow[]> {
    const members = await this.db.all<MemberRow>('SELECT * FROM session_members WHERE agent_id = ?', [id]);
    await this.db.run('DELETE FROM session_members WHERE agent_id = ?', [id]);
    await this.db.run('UPDATE agents SET deleted_at = ?, mine = 0 WHERE id = ?', [this.now(), id]);
    return members;
  }

  /** 復原刪掉的 Agent；這段時間又從圖鑑加了同一個角色（另一份）的話，併回這一份 */
  async restoreAgent(id: string, mine: boolean, members: MemberRow[] = []): Promise<void> {
    const dup = await this.catalogTwin(id);
    if (dup) await this.db.run('UPDATE agents SET deleted_at = ? WHERE id = ?', [this.now(), dup]);
    await this.db.run('UPDATE agents SET deleted_at = NULL, mine = ? WHERE id = ?', [mine ? 1 : 0, id]);
    if (dup) await this.mergeAgent(dup, id);
    for (const m of members) {
      await this.db.run('INSERT OR IGNORE INTO session_members (session_id, agent_id, position, joined_by, joined_at) VALUES (?, ?, ?, ?, ?)', [
        m.session_id,
        m.agent_id,
        m.position,
        m.joined_by,
        m.joined_at,
      ]);
    }
  }

  /** 同一個圖鑑角色、目前沒刪掉的另一份 */
  private async catalogTwin(id: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      'SELECT b.id FROM agents a JOIN agents b ON b.catalog_id = a.catalog_id AND b.id != a.id AND b.deleted_at IS NULL WHERE a.id = ? AND a.catalog_id IS NOT NULL',
      [id]
    );
    return row?.id ?? null;
  }

  /** 把 from 併進 into：成員、筆記、說過的話都改成 into 的，再刪掉 from */
  private async mergeAgent(from: string, into: string): Promise<void> {
    await this.db.run('UPDATE OR IGNORE session_members SET agent_id = ? WHERE agent_id = ?', [into, from]);
    await this.db.run('UPDATE agent_notes SET agent_id = ? WHERE agent_id = ?', [into, from]);
    await this.db.run('UPDATE messages SET agent_id = ? WHERE agent_id = ?', [into, from]);
    await this.db.run('DELETE FROM agents WHERE id = ?', [from]);
  }

  // ---- 對話成員 ----

  /** 這段對話有哪些 Agent（照加入順序；刪掉的不算，說過的話的名字另外用 agentsByIds 拿） */
  async listMembers(sessionId: string): Promise<Member[]> {
    const rows = await this.db.all<AgentRow & { position: number; joined_by: JoinedBy; joined_at: number }>(
      `SELECT a.*, m.position, m.joined_by, m.joined_at FROM session_members m JOIN agents a ON a.id = m.agent_id
       WHERE m.session_id = ? AND a.deleted_at IS NULL ORDER BY m.position`,
      [sessionId]
    );
    return rows.map((r) => ({ agent: toAgent(r), position: r.position, joinedBy: r.joined_by, joinedAt: r.joined_at }));
  }

  /** 加進對話（已經在裡面就不動） */
  async addMember(sessionId: string, agentId: string, joinedBy: JoinedBy = 'user'): Promise<void> {
    const last = await this.db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM session_members WHERE session_id = ?', [sessionId]);
    await this.db.run(
      'INSERT OR IGNORE INTO session_members (session_id, agent_id, position, joined_by, joined_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, agentId, (last?.p ?? -1) + 1, joinedBy, this.now()]
    );
  }

  /** 放回拿掉的成員（原本的位置、怎麼加入的都照舊） */
  async restoreMember(row: MemberRow): Promise<void> {
    await this.db.run('INSERT OR IGNORE INTO session_members (session_id, agent_id, position, joined_by, joined_at) VALUES (?, ?, ?, ?, ?)', [
      row.session_id,
      row.agent_id,
      row.position,
      row.joined_by,
      row.joined_at,
    ]);
  }

  async removeMember(sessionId: string, agentId: string): Promise<void> {
    await this.db.run('DELETE FROM session_members WHERE session_id = ? AND agent_id = ?', [sessionId, agentId]);
  }

  // ---- Agent 的筆記 ----

  async addNote(agentId: string, sessionId: string | null, content: string): Promise<AgentNote> {
    const note: AgentNote = { id: newId(), agentId, sessionId, content, createdAt: this.now() };
    await this.db.run('INSERT INTO agent_notes (id, agent_id, session_id, content, created_at) VALUES (?, ?, ?, ?, ?)', [
      note.id,
      agentId,
      sessionId,
      content,
      note.createdAt,
    ]);
    return note;
  }

  /** 最近的在後面（照時間順序，給模型看比較自然）；limit 取最近幾則 */
  async listNotes(agentId: string, limit = 100): Promise<AgentNote[]> {
    const rows = await this.db.all<{ id: string; agent_id: string; session_id: string | null; content: string; created_at: number }>(
      'SELECT * FROM (SELECT *, rowid AS r FROM agent_notes WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, r',
      [agentId, limit]
    );
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, sessionId: r.session_id, content: r.content, createdAt: r.created_at }));
  }

  async updateNote(id: string, content: string): Promise<void> {
    await this.db.run('UPDATE agent_notes SET content = ? WHERE id = ?', [content, id]);
  }

  async deleteNote(id: string): Promise<void> {
    await this.db.run('DELETE FROM agent_notes WHERE id = ?', [id]);
  }

  async clearNotes(agentId: string): Promise<void> {
    await this.db.run('DELETE FROM agent_notes WHERE agent_id = ?', [agentId]);
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
    await this.purgeUnusedAgents(this.now());
    // 清除全部資料：用量紀錄也清掉（可以復原的那幾秒內不動）
    await this.db.run('DELETE FROM usage_log');
    await this.db.exec('VACUUM');
  }

  /** 清除前先記下主機、設定、Agent 與筆記，復原時放回去 */
  async snapshotSettings(): Promise<Snapshot> {
    return {
      hosts: await this.listHosts(),
      settings: await this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings'),
      agents: await this.db.all<Record<string, SqlValue>>('SELECT * FROM agents'),
      notes: await this.db.all<Record<string, SqlValue>>('SELECT * FROM agent_notes'),
    };
  }

  async restoreSnapshot(snap: Snapshot): Promise<void> {
    await this.db.exec('DELETE FROM hosts; DELETE FROM settings; DELETE FROM agent_notes;');
    for (const h of snap.hosts) await this.restoreHost(h);
    for (const s of snap.settings) await this.setSetting(s.key, s.value);
    // Agent 用「有就更新」放回去：不能用 REPLACE（會先刪掉那一列，連帶刪掉它在所有對話的成員紀錄）
    for (const row of snap.agents) {
      const cols = Object.keys(row);
      const id = String(row.id);
      const dup = row.deleted_at === null && row.catalog_id !== null ? await this.db.get<{ id: string }>('SELECT id FROM agents WHERE catalog_id = ? AND deleted_at IS NULL AND id != ?', [row.catalog_id, id]) : null;
      if (dup) await this.db.run('UPDATE agents SET deleted_at = ? WHERE id = ?', [this.now(), dup.id]);
      await this.db.run(
        `INSERT INTO agents (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
         ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`,
        cols.map((c) => row[c])
      );
      if (dup) await this.mergeAgent(dup.id, id);
    }
    for (const row of snap.notes) {
      const cols = Object.keys(row);
      await this.db.run(`INSERT OR REPLACE INTO agent_notes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
    }
  }

  /**
   * 清掉主機、設定、筆記；Agent 不再列在「我的 Agent」，沒在任何對話裡的先藏起來（之後真的刪）。
   * 還在對話（含最近刪除）裡的留著：從最近刪除救回那段時，成員照樣在
   */
  async clearSettings(): Promise<void> {
    await this.db.exec('DELETE FROM hosts; DELETE FROM templates; DELETE FROM settings; DELETE FROM agent_notes;');
    await this.db.run('UPDATE agents SET mine = 0');
    await this.db.run('UPDATE agents SET deleted_at = COALESCE(deleted_at, ?) WHERE NOT EXISTS (SELECT 1 FROM session_members m WHERE m.agent_id = agents.id)', [this.now()]);
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
