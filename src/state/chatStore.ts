import { hostUrl, parseHostInput, scanHosts, subnetCandidates } from '../lib/discovery';
import { HELPER_PORT, pairErrorMessage, parsePairingPayload } from '../lib/helper';
import { contextLevel, type ContextLevel } from '../lib/format';
import { cleanTitle, fallbackTitle } from '../lib/title';
import { REPLY_PROMPTS, buildChatMessages, defaultImageQuestion } from '../lib/history';
import { pickDefaultModel } from '../lib/modelPick';
import { OllamaError, splitThink, type ChatMessage, type DownloadJob, type HelperHello, type HelperInfo, type LoadedModel, type ModelInfo, type OllamaClient, type ThinkSetting } from '../lib/ollama';
import type { Db } from '../store/db';
import { ToolPermissionError, declinedPrompt, describeChanges, editedPrompt, unansweredPrompt, undonePrompt, needsConfirmation, parseArguments, toOllamaTools, toolGroupName, toolOffError, toolResultContent, toolSystemPrompt, toolsOffPrompt, validateInput, type PhoneTool, type ToolCall, type ToolGroup, type ToolInput } from '../lib/tools';
import { DEFAULT_GROUP, RECORD_NOTE, THREAD_ROOT, isRecordNote, isThreadRoot, type Action, type Agent, type Attachment, type GroupSettings, type Host, type Member, type Message, type Repo, type Session, type AgentCard, type AgentNote } from '../store/repo';
import { PromptStore, entryIntro, entryName, getEntry, searchCatalog, type CatalogEntry } from '../agents/catalog';
import {
  AGENT_DRAFT_SCHEMA,
  PICK_ROLES_SCHEMA,
  agentDraftMessages,
  pickRolesMessages,
  BID_SCHEMA,
  CONCLUSION,
  CONCLUSION_SCHEMA,
  HOST_SCHEMA,
  OPTIONS_SCHEMA,
  VOTE_SCHEMA,
  conclusionMessages,
  noteMessages,
  optionsMessages,
  parseConclusion,
  voteMessages,
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
  wantsConclusion,
  type Bid,
  type Conclusion,
  type Line,
  type Speaker,
} from '../agents/discussion';
import { askUserTool } from '../tools/ask';
import { setLanguage, t } from '../i18n';

// 聊天的所有狀態與動作都在這裡；畫面只負責顯示與呼叫。這樣不用手機也能完整測試。

export type HostStatus = { state: 'checking' | 'online' | 'offline'; latencyMs: number | null; version: string };

export type ModelsEntry = { list: ModelInfo[]; loading: boolean; error: string; /** 小幫手回的錯誤代碼，例如 no_engine（電腦連得到，但 AI 引擎沒開） */ errorCode?: string };

export type Streaming = {
  messageId: string;
  content: string;
  thinking: string;
  startedAt: number;
  /** waiting：等模型開始回、thinking：正在思考、answering：正在回答 */
  phase: 'waiting' | 'thinking' | 'answering';
  /** 模型還沒載入，電腦要先把它載入記憶體（第一次用要等比較久）；還不知道是 undefined */
  loading?: boolean;
  /** 多 AI 討論：正在講的 Agent */
  agentId?: string;
};

/** 多 AI 討論進行到哪：大家在舉手、主持人在點名、某人在講、在整理前情摘要、在收尾 */
export type DiscussionPhase = { phase: 'bidding' | 'hosting' | 'speaking' | 'summarizing' | 'concluding'; agentId: string | null };

/** 一則訊息的 detail：角色說明太長，這次截短了（畫面上註明） */
export const ROLE_TRUNCATED = 'role-truncated';

/** 連不到電腦的原因（白話說明在 diagnosisText） */
export type Diagnosis =
  | { kind: 'ok' }
  | { kind: 'moved'; url: string }
  | { kind: 'no-wifi' }
  | { kind: 'other-network'; phoneIp: string; hostIp: string }
  | { kind: 'vpn-off' }
  | { kind: 'vpn-no-response' }
  | { kind: 'refused'; helper: boolean }
  | { kind: 'no-response'; helper: boolean };

/** 給使用者看的原因與下一步 */
export function diagnosisText(d: Diagnosis): string {
  switch (d.kind) {
    case 'ok':
      return t('現在連得到了。');
    case 'moved':
      return t('電腦換了網路位址，已經自動改好了。');
    case 'no-wifi':
      return t('手機沒有連 Wi-Fi。請連上跟電腦同一個 Wi-Fi；不在家時要用 Tailscale 這類工具才連得到。');
    case 'other-network':
      return t('手機（{p0}）和電腦（{p1}）不在同一個網路。請確認手機連的是家裡的 Wi-Fi，不是訪客網路或另一台路由器。', { p0: d.phoneIp, p1: d.hostIp });
    case 'vpn-off':
      return t('手機的 Tailscale 沒有開。這台電腦是透過 Tailscale 連的，請打開手機上的 Tailscale。');
    case 'vpn-no-response':
      return t('電腦沒有回應。這台電腦是透過 Tailscale 連的：請確認電腦開著、沒有睡著，電腦上的 Tailscale 也開著。');
    case 'refused':
      return d.helper
        ? t('電腦開著，但 Local AI 小幫手沒有開。請在電腦的應用程式選單（Windows 是「開始」功能表）打開「Local AI 小幫手」。')
        : t('電腦開著，但 Ollama 沒有開，或沒有開放讓區網連線。');
    case 'no-response':
      return d.helper
        ? t('電腦沒有回應：可能睡著或關機了。電腦開著的話，可能是防火牆擋住手機，電腦上的小幫手畫面會教你怎麼放行。')
        : t('電腦沒有回應：可能睡著或關機了，或是防火牆擋住手機。');
  }
}

const isTailscaleIp = (ip: string) => {
  const m = /^100\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
};
const sameSubnet = (a: string, b: string) => a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');

export type ContextInfo = { used: number; limit: number | null; level: ContextLevel };

/** 掃描時找到、還沒配對的小幫手（要輸入配對碼） */
export type FoundHelper = { url: string; id: string; name: string; pairing: boolean };

export type ScanState = { running: boolean; done: number; total: number; found: number; error: string; helpers?: FoundHelper[] };

/** 存權杖的安全儲存區（手機上是 iOS 鑰匙圈；權杖不放資料庫，備份檔裡就不會有） */
export type SecretStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export function memorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

const tokenKey = (helperId: string) => `helper-token.${helperId}`;

/** 手動輸入的位址是小幫手：要輸入配對碼 */
export class NeedsPairingError extends Error {
  constructor(
    readonly url: string,
    readonly name: string
  ) {
    super(t('這台電腦用的是 Local AI 小幫手，要輸入配對碼。'));
  }
}

/** 配對失敗（訊息已經是白話） */
export class PairError extends Error {}

export type ChatState = {
  ready: boolean;
  hosts: Host[];
  hostStatus: Record<string, HostStatus>;
  scan: ScanState | null;
  models: Record<string, ModelsEntry>;
  loaded: Record<string, LoadedModel[]>;
  /** 電腦能下載到哪個引擎、配備（直接連 Ollama：只能下載到 Ollama、不知道配備） */
  helperInfo: Record<string, HelperInfo>;
  /** 每台電腦的下載工作 */
  downloads: Record<string, DownloadJob[]>;
  session: Session | null;
  messages: Message[];
  streaming: Streaming | null;
  context: ContextInfo | null;
  /** 一次性的提示，例如「這個模型看不懂圖片，前面的照片不會送出」 */
  notice: string;
  /** 剛做的刪除或取代，可以按「復原」（畫面顯示幾秒後消失） */
  undo: { id: number; message: string } | null;
  prefs: Prefs;
  /** 清單卡正在一件一件做：做到第幾件 */
  acting: { messageId: string; done: number; total: number } | null;
  /** 目前這段對話的討論串：key 是開討論串的那一題（使用者訊息的 id），count 是裡面問了幾次 */
  threads: Record<string, { id: string; count: number }>;
  /** 正在回答的對話（換到別段、關掉討論串都照樣在背景回答）：值是它掛在哪段對話底下（一般對話是 null） */
  running: Record<string, string | null>;
  /** 在背景答完、還沒打開看過的討論串 */
  fresh: string[];
  /** 目前這段對話的成員（有成員就是多 AI 討論） */
  members: Member[];
  /** 目前這段對話用到的 Agent（成員，加上說過話但已經離開的） */
  agents: Record<string, Agent>;
  /** 目前這段對話的討論進行到哪（沒在討論是 null） */
  discussion: DiscussionPhase | null;
  /** AI 覺得可以收尾的對話（畫面出現「要收尾嗎？」） */
  suggestConclude: string[];
  /** 「我的 Agent」（設定頁、加成員用；打開時才讀） */
  myAgents: Agent[];
};

/** 一句話生成、還沒存的角色卡 */
export type AgentDraft = Pick<Agent, 'name' | 'intro' | 'emoji' | 'talk'> & { card: AgentCard };

type PendingUndo = { id: number; message: string; undo: () => Promise<void>; commit?: () => Promise<void> };

/** 一段對話正在跑的回答或討論 */
type Run = {
  abort: AbortController;
  /** 正在串流的那一則（討論在舉手時沒有） */
  streaming: Streaming | null;
  parentId: string | null;
  /** 多 AI 討論：進行到哪、你在中途插話了 */
  phase?: DiscussionPhase | null;
  interject?: boolean;
};

/** 討論為什麼停下來：沒人想講、到連續上限、按了暫停、出錯 */
type StopReason = 'quiet' | 'cap' | 'stopped' | 'error';

/** 舉手、主持人、摘要這種小呼叫：思考關掉（或用最低等級），才快 */
function quickThink(info: ModelInfo | undefined): ThinkSetting | undefined {
  if (!info?.think) return undefined;
  if (info.think.kind === 'always') return true;
  return info.think.kind === 'toggle' ? false : info.think.levels[0];
}

/** 模型還沒載入、查不到實際上下文時，當作只有這麼多（Ollama 預設常是 4096） */
const ASSUMED_CONTEXT = 4096;
/** 討論中一次最多幾個「我的 Agent」舉手要不要自己加入 */
const MAX_OUTSIDERS = 6;

export type AppLanguage = 'zh-Hant' | 'en';
/** 使用者在設定裡可以改的偏好 */
export type Prefs = {
  /** App 語言：跟著系統，或指定（AI 也用這個語言回答） */
  language: 'system' | AppLanguage;
  /** 設定頁「AI 可以做的事」關掉的分類 */
  toolsOff: ToolGroup[];
};

export const DEFAULT_PREFS: Prefs = { language: 'system', toolsOff: [] };

export type ChatEvent = 'answered' | 'failed' | 'stopped' | 'downloaded' | 'acted';

export type ChatDeps = {
  repo: Repo;
  /** token：透過小幫手連線時配對拿到的權杖 */
  client: (url: string, token?: string) => OllamaClient;
  /** 存小幫手權杖的地方（沒給就放記憶體，測試用） */
  secrets?: SecretStore;
  /** 配對時告訴電腦這支手機叫什麼 */
  deviceName?: () => string;
  /** 手機目前的 Wi-Fi 位址；沒連 Wi-Fi 回 null（不掃描） */
  wifiIp: () => Promise<string | null>;
  /** 手機有沒有開 VPN（Tailscale）；不知道回 null */
  vpnOn?: () => Promise<boolean | null>;
  now?: () => number;
  /** 串流更新畫面的最短間隔（毫秒），太頻繁會讓 Markdown 一直重排 */
  throttleMs?: number;
  /** 開 App 時，在 Wi-Fi 上且沒有在線的主機就自動掃描區網（預設開） */
  autoScan?: boolean;
  /** 手機系統的語言（「跟著系統」時用） */
  deviceLanguage?: () => AppLanguage;
  /** 開一個暫時的記憶體資料庫（從備份還原前，先把目前的資料存一份給「復原」用） */
  openMemoryDb?: () => Promise<Db>;
  /** 下載中多久問一次進度（毫秒） */
  pollMs?: number;
  /** 送出時順便確認電腦連不連得到的逾時（毫秒）；連不到就不用等到聊天逾時 */
  probeTimeoutMs?: number;
  /** AI 可以在手機上叫的工具（行事曆、提醒事項…）；沒給就只聊天 */
  tools?: PhoneTool[];
  /** 手機的時區（告訴模型現在幾點用） */
  timeZone?: () => string;
  /** 圖鑑 Agent 的角色原文（沒給就只用名字與介紹，測試用） */
  prompts?: PromptStore;
  onEvent?: (event: ChatEvent) => void;
};

export class HostOfflineError extends Error {
  constructor(
    readonly url: string,
    readonly label: string,
    reason: string
  ) {
    super(reason);
    this.name = 'HostOfflineError';
  }
}

/** 請模型幫對話取標題用的系統提示詞 */
/** 請模型取標題的提示詞（依回答語言；給 AI 的指示，不跟著畫面翻譯） */
export const TITLE_PROMPTS = {
  'zh-Hant': '幫下面這段對話取一個標題：繁體中文、15 個字以內、只回標題本身，不要引號和標點。', // i18n-ignore
  en: 'Write a title for the conversation below: in English, at most 6 words, reply with the title only, no quotes or punctuation.',
} as const;

const SETTING_LAST_HOST = 'lastHost';
const SETTING_PREFS = 'prefs';
/** 「清除全部資料」還沒確定（還在可以復原的那幾秒）就關掉 App 時，下次打開要真的刪掉的對話 */
const SETTING_PENDING_WIPE = 'pendingWipe';
/** 使用者自己按過「自動尋找」（iPhone 的區域網路權限已經問過），之後開 App 才自動找 */
const SETTING_SCAN_CONSENTED = 'scanConsented';
const SETTING_LAST_MODEL = 'lastModel';
/** 發現「一定會思考」的模型（關掉思考還是會想）：記下來，之後直接開著思考送出 */
const SETTING_ALWAYS_THINK = 'alwaysThinkModels';
const PROBE_TIMEOUT_MS = 2500;
/** 一次問題最多讓 AI 叫幾輪工具（小模型可能在原地打轉） */
export const MAX_TOOL_ROUNDS = 5;
const SCAN_TIMEOUT_MS = 800;
const WIFI_TIMEOUT_MS = 3000;

/** 錯誤翻成一般人看得懂的一句話（技術細節另外用 errorDetail 取） */
export function describeError(e: unknown): string {
  if (e instanceof OllamaError) {
    if (e.kind === 'network') return t('連不到你的電腦。');
    if (e.kind === 'timeout') return t('電腦太久沒有回應。');
    if (e.kind === 'cancelled') return t('已取消。');
    if (e.kind === 'unpaired') return e.message;
    if (e.code === 'no_engine' || e.code === 'engine_unreachable') return t('電腦上的 AI 引擎沒有開著。請到電腦的 Local AI 小幫手畫面，按「安裝 Ollama」或「打開 Ollama」。');
    if (e.kind === 'http' && /not found/i.test(e.message)) return t('電腦上找不到這個模型，可能已經被刪除，請換一個模型。');
    if (e.kind === 'http') return t('電腦拒絕了這次請求。');
    return t('電腦回報錯誤：{p0}', { p0: e.message });
  }
  return e instanceof Error ? e.message : String(e);
}

/** 原始的錯誤內容，給「詳細資訊」用 */
export function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 選了某個模型之後，思考設定的預設值：開關型預設關（比較快），分段型用模型預設等級 */
export function defaultThink(model: ModelInfo | undefined): ThinkSetting | null {
  if (!model?.think) return null;
  if (model.think.kind === 'always') return true;
  return model.think.kind === 'toggle' ? false : model.think.defaultLevel;
}

/** 實際要送給模型的思考設定：一定會思考的模型永遠開著（不然 Ollama 不會把思考分出來） */
function thinkToSend(info: ModelInfo | undefined, chosen: ThinkSetting | null): ThinkSetting | undefined {
  if (!info?.think) return undefined;
  if (info.think.kind === 'always') return true;
  return chosen ?? defaultThink(info) ?? undefined;
}

export class ChatStore {
  private state: ChatState = {
    ready: false,
    hosts: [],
    hostStatus: {},
    scan: null,
    models: {},
    loaded: {},
    helperInfo: {},
    downloads: {},
    session: null,
    messages: [],
    streaming: null,
    context: null,
    notice: '',
    undo: null,
    prefs: DEFAULT_PREFS,
    acting: null,
    threads: {},
    running: {},
    fresh: [],
    members: [],
    agents: {},
    discussion: null,
    suggestConclude: [],
    myAgents: [],
  };
  private pendingUndo: PendingUndo | null = null;
  private undoCounter = 0;
  private listeners = new Set<() => void>();
  /** 正在幫對話取標題（測試用來等它完成） */
  titleTask: Promise<void> | null = null;
  /** 開 App 時的檢查主機＋自動掃描（測試用來等它完成） */
  startupTask: Promise<void> | null = null;
  /** 換對話後讀成員（測試用來等它完成） */
  groupTask: Promise<void> | null = null;
  private scanAbort: AbortController | null = null;
  /** 正在問下載進度的電腦 */
  private polling = new Set<string>();
  /** 手機直接叫 Ollama 下載的工作（可以取消） */
  private pullAborts = new Map<string, AbortController>();
  /** 手機直接下載的工作（測試用來等它完成） */
  downloadTask: Promise<void> | null = null;
  /** 一定會思考的模型（「電腦網址 模型名稱」） */
  private alwaysThink = new Set<string>();
  private readonly now: () => number;
  private readonly throttleMs: number;

  private readonly prompts: PromptStore;

  constructor(private readonly deps: ChatDeps) {
    this.now = deps.now ?? Date.now;
    this.throttleMs = deps.throttleMs ?? 50;
    this.prompts = deps.prompts ?? new PromptStore(async () => ({}));
  }

  // ---- 訂閱 ----

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ChatState>) {
    const before = this.state.session?.id;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
    // 換了一段對話：成員、討論進度跟著換
    if ('session' in patch && patch.session?.id !== before) {
      const run = patch.session ? this.runs.get(patch.session.id) : undefined;
      this.set({ discussion: run?.phase ?? null, members: [], agents: {} });
      this.groupTask = this.refreshGroup();
    }
  }

  // ---- 偏好設定 ----

  private async loadPrefs(): Promise<Prefs> {
    const raw = await this.deps.repo.getSetting(SETTING_PREFS);
    try {
      return { ...DEFAULT_PREFS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return DEFAULT_PREFS;
    }
  }

  async setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void> {
    const prefs = { ...this.state.prefs, [key]: value };
    await this.deps.repo.setSetting(SETTING_PREFS, JSON.stringify(prefs));
    this.state = { ...this.state, prefs };
    setLanguage(this.appLanguage()); // 先換語言再通知畫面，重畫時就是新語言
    this.set({ prefs });
  }

  /** 目前實際的 App 語言 */
  appLanguage(): AppLanguage {
    const pref = this.state.prefs.language;
    return pref === 'system' ? (this.deps.deviceLanguage?.() ?? 'zh-Hant') : pref;
  }

  // ---- 復原 ----

  /** 記下一個可以復原的操作；之前那個還沒處理的就當作確定 */
  private async offerUndo(message: string, undo: () => Promise<void>, commit?: () => Promise<void>): Promise<void> {
    await this.dismissUndo();
    this.pendingUndo = { id: ++this.undoCounter, message, undo, commit };
    this.set({ undo: { id: this.pendingUndo.id, message } });
  }

  /** 按「復原」 */
  async undoLast(): Promise<void> {
    const p = this.pendingUndo;
    if (!p) return;
    this.pendingUndo = null;
    this.set({ undo: null });
    await p.undo();
  }

  /** 提示消失（時間到或換了別的操作）：這個操作就確定了 */
  async dismissUndo(): Promise<void> {
    const p = this.pendingUndo;
    if (!p) return;
    this.pendingUndo = null;
    if (this.state.undo?.id === p.id) this.set({ undo: null });
    await p.commit?.();
  }

  /** 目前的對話換成最近的一段（沒有就開新的） */
  private async openLatestOrNew(): Promise<void> {
    const { repo } = this.deps;
    const latest = (await repo.listSessions())[0];
    if (latest) this.set({ session: latest, messages: await repo.listMessages(latest.id), context: null, notice: '', threads: await this.threadMap(latest), streaming: this.runs.get(latest.id)?.streaming ?? null });
    else this.set({ session: await this.createSessionFromLast(), messages: [], context: null, notice: '', threads: {}, streaming: null });
  }

  // ---- 查詢 ----

  /** 目前對話用的模型資訊（主機的模型清單還沒載入時是 undefined） */
  currentModel(): ModelInfo | undefined {
    const s = this.state.session;
    if (!s?.hostUrl || !s.model) return undefined;
    return this.state.models[s.hostUrl]?.list.find((m) => m.name === s.model);
  }

  hostLabel(url: string | null | undefined): string {
    if (!url) return '';
    return this.state.hosts.find((h) => h.url === url)?.label ?? url.replace(/^https?:\/\//, '');
  }

  // ---- 啟動 ----

  async init(): Promise<void> {
    const { repo } = this.deps;
    // 先用手機語言（第一次開 App 放的預設範本才會是對的語言），讀到設定後再套用使用者選的
    setLanguage(this.deps.deviceLanguage?.() ?? 'zh-Hant');
    await repo.migrate();
    await repo.purgeExpired();
    const pendingWipe = await repo.getSetting(SETTING_PENDING_WIPE);
    if (pendingWipe) await repo.wipe(JSON.parse(pendingWipe) as string[]);
    const hosts = await repo.listHosts();
    await this.loadTokens(hosts);
    try {
      this.alwaysThink = new Set(JSON.parse((await repo.getSetting(SETTING_ALWAYS_THINK)) ?? '[]'));
    } catch {
      this.alwaysThink = new Set();
    }
    const latest = (await repo.listSessions())[0];
    const session = latest ?? (await this.createSessionFromLast());
    const prefs = await this.loadPrefs();
    this.state = { ...this.state, prefs };
    setLanguage(this.appLanguage());
    this.set({
      hosts,
      session,
      messages: await repo.listMessages(session.id),
      threads: await this.threadMap(session),
      prefs,
      ready: true,
    });
    if (session.hostUrl) void this.loadModels(session.hostUrl);
    this.startupTask = this.refreshHosts().then(() => this.autoScan());
  }

  /**
   * 開 App 時：沒有在線的電腦、手機連著 Wi-Fi、而且使用者以前自己按過「自動尋找」，就自動找一次。
   * 第一次一定要使用者自己按，iPhone 才會在有前後文的時候問區域網路權限。
   */
  private async autoScan(): Promise<void> {
    if (this.deps.autoScan === false) return;
    if ((await this.deps.repo.getSetting(SETTING_SCAN_CONSENTED)) !== '1') return;
    const online = Object.values(this.state.hostStatus).some((st) => st.state === 'online');
    if (online || !(await this.deps.wifiIp())) return;
    await this.scanLan();
  }

  private async createSessionFromLast(): Promise<Session> {
    const { repo } = this.deps;
    const hostUrl = await repo.getSetting(SETTING_LAST_HOST);
    const model = await repo.getSetting(SETTING_LAST_MODEL);
    const info = hostUrl ? this.state.models[hostUrl]?.list.find((m) => m.name === model) : undefined;
    return repo.createSession({ hostUrl, model, think: info ? defaultThink(info) : null });
  }

  // ---- 主機 ----

  /** 問每台主機在不在線、回應多快 */
  async refreshHosts(): Promise<void> {
    const { repo } = this.deps;
    const hosts = this.state.hosts;
    this.set({
      hostStatus: Object.fromEntries(hosts.map((h) => [h.url, { state: 'checking', latencyMs: null, version: h.version } as HostStatus])),
    });
    await Promise.all(
      hosts.map(async (h) => {
        let status: HostStatus;
        try {
          const v = await this.clientFor(h.url).version(PROBE_TIMEOUT_MS);
          status = { state: 'online', latencyMs: v.latencyMs, version: v.version };
          await repo.markHostSeen(h.url, v.version);
        } catch {
          status = { state: 'offline', latencyMs: null, version: h.version };
        }
        this.set({ hostStatus: { ...this.state.hostStatus, [h.url]: status } });
      })
    );
    this.set({ hosts: await repo.listHosts() });
  }

  /**
   * 自動尋找：掃描手機所在的 Wi-Fi 網段，找到的電腦記起來；還沒選模型的話直接連上第一台並選好模型。
   * 回傳找到幾台；不能找時 scan.error 會寫原因。userInitiated 代表使用者自己按的。
   */
  async scanLan(options: { userInitiated?: boolean } = {}): Promise<number> {
    const { repo, client, wifiIp } = this.deps;
    if (this.state.scan?.running) return 0;
    if (options.userInitiated) await repo.setSetting(SETTING_SCAN_CONSENTED, '1');
    // 先顯示「檢查網路中」，讓使用者知道有在動
    this.set({ scan: { running: true, done: 0, total: 0, found: 0, error: '' } });
    let ip: string | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      ip = await Promise.race([
        wifiIp(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(t('等了 3 秒沒有回應'))), WIFI_TIMEOUT_MS))),
      ]);
    } catch (e) {
      clearTimeout(timer);
      this.set({ scan: { running: false, done: 0, total: 0, found: 0, error: t('沒辦法確認手機的網路（{p0}）。請改用「手動輸入位址」。', { p0: errorDetail(e) }) } });
      return 0;
    }
    clearTimeout(timer);
    const candidates = ip ? subnetCandidates(ip) : [];
    if (candidates.length === 0) {
      this.set({
        scan: {
          running: false,
          done: 0,
          total: 0,
          found: 0,
          error: ip
            ? t('這個 Wi-Fi 沒辦法自動尋找。請改用「手動輸入位址」。')
            : t('手機目前沒有連 Wi-Fi，沒辦法自動尋找。請連上跟電腦同一個 Wi-Fi，或改用「手動輸入位址」。'),
        },
      });
      return 0;
    }
    this.scanAbort = new AbortController();
    this.set({ scan: { running: true, done: 0, total: candidates.length, found: 0, error: '' } });
    const helpers = new Map<string, HelperHello & { url: string }>();
    const found = await scanHosts(
      candidates,
      async (ip) => {
        const helperUrl = hostUrl(ip, HELPER_PORT);
        const hello = await client(helperUrl).helperHello(SCAN_TIMEOUT_MS);
        if (hello) {
          helpers.set(ip, { ...hello, url: helperUrl });
          return hello.version || 'helper';
        }
        return (await client(hostUrl(ip)).version(SCAN_TIMEOUT_MS)).version;
      },
      {
        signal: this.scanAbort.signal,
        onProgress: (done) => this.set({ scan: { ...this.state.scan!, done } }),
        onFound: () => this.set({ scan: { ...this.state.scan!, found: this.state.scan!.found + 1 } }),
      }
    );
    const hostStatus = { ...this.state.hostStatus };
    const unpaired: FoundHelper[] = [];
    let firstUsable: string | null = null;
    for (const f of found) {
      const helper = helpers.get(f.url);
      if (helper) {
        // 配對過的小幫手：位址變了就跟著改；沒配對過的列出來讓使用者輸入配對碼
        const known = this.state.hosts.find((h) => h.helperId === helper.id);
        if (known && this.tokens.has(helper.id)) {
          await repo.moveHost(known.url, helper.url);
          await repo.saveHost({ url: helper.url, label: helper.name || known.label, source: 'helper', helperId: helper.id, version: helper.version });
          hostStatus[helper.url] = { state: 'online', latencyMs: null, version: helper.version };
          firstUsable ??= helper.url;
        } else {
          unpaired.push({ url: helper.url, id: helper.id, name: helper.name, pairing: helper.pairing });
        }
        continue;
      }
      const url = hostUrl(f.url);
      await repo.saveHost({ url, label: f.url, source: 'scan', version: f.version });
      hostStatus[url] = { state: 'online', latencyMs: null, version: f.version };
      firstUsable ??= url;
    }
    this.set({ hosts: await repo.listHosts(), hostStatus, scan: { ...this.state.scan!, running: false, helpers: unpaired } });
    if (this.state.session) this.set({ session: (await repo.getSession(this.state.session.id)) ?? this.state.session });
    this.scanAbort = null;
    if (firstUsable && !this.state.session?.model) await this.connectHost(firstUsable);
    return found.length;
  }

  // ---- Local AI 小幫手 ----

  /** 小幫手的權杖：helperId 對到權杖（開 App 時從安全儲存區讀進來） */
  private tokens = new Map<string, string>();

  private get secrets(): SecretStore {
    this.deps.secrets ??= memorySecrets();
    return this.deps.secrets;
  }

  private async forgetToken(helperId: string): Promise<void> {
    this.tokens.delete(helperId);
    await this.secrets.remove(tokenKey(helperId)).catch(() => {});
  }

  private async loadTokens(hosts: Host[]): Promise<void> {
    for (const h of hosts) {
      if (!h.helperId || this.tokens.has(h.helperId)) continue;
      const token = await this.secrets.get(tokenKey(h.helperId)).catch(() => null);
      if (token) this.tokens.set(h.helperId, token);
    }
  }

  /** 連某台電腦用的連線（小幫手會帶上權杖） */
  private clientFor(url: string): OllamaClient {
    const helperId = this.state.hosts.find((h) => h.url === url)?.helperId;
    return this.deps.client(url, helperId ? this.tokens.get(helperId) : undefined);
  }

  /** 這台電腦是不是透過小幫手、而且這支手機還沒配對（或配對被移除） */
  needsPairing(url: string): boolean {
    const helperId = this.state.hosts.find((h) => h.url === url)?.helperId;
    return !!helperId && !this.tokens.has(helperId);
  }

  /**
   * 掃電腦上小幫手的 QR code 配對：依序試 QR code 裡的位址，找到同一台小幫手就配對。
   * 失敗丟 PairError（訊息是白話）。回傳電腦的位址。
   */
  async pairFromQr(text: string): Promise<string> {
    const payload = parsePairingPayload(text);
    if (!payload) throw new PairError(t('這不是 Local AI 小幫手的 QR code。請掃描電腦上小幫手畫面裡的 QR code。'));
    for (const ip of payload.ips) {
      const url = hostUrl(ip, payload.port);
      const hello = await this.deps.client(url).helperHello(PROBE_TIMEOUT_MS);
      if (hello?.id === payload.id) return this.pairHelper(url, payload.code, hello);
    }
    throw new PairError(t('掃到了，但手機連不到「{p0}」。請確認手機和電腦連同一個 Wi-Fi。', { p0: payload.name || t('這台電腦') }));
  }

  /** 用配對碼跟小幫手配對；成功就存起來、連上，回傳位址。失敗丟 PairError */
  async pairHelper(url: string, code: string, known?: HelperHello): Promise<string> {
    const { repo } = this.deps;
    const hello = known ?? (await this.deps.client(url).helperHello(PROBE_TIMEOUT_MS));
    if (!hello) throw new PairError(t('連不到這台電腦。請確認手機和電腦連同一個 Wi-Fi，而且小幫手開著。'));
    let paired: { token: string; helperId: string; name: string };
    try {
      paired = await this.deps.client(url).pair(code, this.deps.deviceName?.() ?? 'iPhone');
    } catch (e) {
      throw new PairError(pairErrorMessage(e));
    }
    const helperId = paired.helperId || hello.id;
    await this.secrets.set(tokenKey(helperId), paired.token);
    this.tokens.set(helperId, paired.token);
    // 同一台小幫手以前用別的位址配對過：換成新位址（對話跟著走）
    const old = this.state.hosts.find((h) => h.helperId === helperId && h.url !== url);
    if (old) await repo.moveHost(old.url, url);
    await repo.saveHost({ url, label: paired.name || hello.name || url, source: 'helper', helperId, version: hello.version });
    const helpers = (this.state.scan?.helpers ?? []).filter((h) => h.id !== helperId);
    this.set({
      hosts: await repo.listHosts(),
      hostStatus: { ...this.state.hostStatus, [url]: { state: 'online', latencyMs: null, version: hello.version } },
      ...(this.state.scan ? { scan: { ...this.state.scan, helpers } } : {}),
    });
    if (this.state.session) this.set({ session: (await repo.getSession(this.state.session.id)) ?? this.state.session });
    await this.connectHost(url);
    // 不發 'answered'：連接面板配對成功時自己會震一次（以前會連震兩次，播報也說成「回答好了」）
    return url;
  }

  stopScan(): void {
    this.scanAbort?.abort();
  }

  /**
   * 手動新增主機。先確認連得到；連不到時丟 HostOfflineError，畫面可以問使用者要不要照樣加入（force）。
   * 格式錯誤丟一般 Error。
   */
  async addHost(input: string, options: { force?: boolean; label?: string } = {}): Promise<Host> {
    const { repo, client } = this.deps;
    const parsed = parseHostInput(input);
    if ('error' in parsed) throw new Error(parsed.error);
    // 是小幫手就要輸入配對碼（沒寫連接埠時試小幫手的連接埠）
    const portGiven = /:\d+\/?$/.test(input.trim().replace(/\/+$/, ''));
    const helperUrl = portGiven ? parsed.url : parsed.url.replace(/:\d+$/, `:${HELPER_PORT}`);
    const hello = await client(helperUrl).helperHello(PROBE_TIMEOUT_MS);
    if (hello) throw new NeedsPairingError(helperUrl, hello.name);
    const label = options.label?.trim() || parsed.label;
    let version = '';
    let status: HostStatus = { state: 'offline', latencyMs: null, version: '' };
    try {
      const v = await client(parsed.url).version(PROBE_TIMEOUT_MS);
      version = v.version;
      status = { state: 'online', latencyMs: v.latencyMs, version };
    } catch (e) {
      if (!options.force) throw new HostOfflineError(parsed.url, label, t('連不到這個位址。'));
    }
    await repo.saveHost({ url: parsed.url, label, source: 'manual', version });
    const hosts = await repo.listHosts();
    this.set({ hosts, hostStatus: { ...this.state.hostStatus, [parsed.url]: status } });
    if (version && !this.state.session?.model) await this.connectHost(parsed.url);
    return hosts.find((h) => h.url === parsed.url)!;
  }

  /**
   * 改用某台電腦：抓模型清單；如果目前的模型不在這台電腦上（或還沒選），自動選一個。
   * 回傳選到的模型名稱（沒有可用的模型回 null）。
   */
  async connectHost(url: string): Promise<string | null> {
    await this.loadModels(url);
    const s = this.state.session;
    const list = this.state.models[url]?.list ?? [];
    if (s?.hostUrl === url && s.model && list.some((m) => m.name === s.model)) return s.model;
    const pick = pickDefaultModel(list, this.state.loaded[url] ?? []);
    if (pick) await this.selectModel(url, pick);
    return pick;
  }

  /** 移除電腦（可以復原） */
  async removeHost(url: string): Promise<void> {
    const { repo } = this.deps;
    const host = this.state.hosts.find((h) => h.url === url);
    if (!host) return;
    const status = this.state.hostStatus[url];
    const modelsEntry = this.state.models[url];
    await repo.removeHost(url);
    const { [url]: _s, ...hostStatus } = this.state.hostStatus;
    const { [url]: _m, ...models } = this.state.models;
    this.set({ hosts: await repo.listHosts(), hostStatus, models });
    await this.offerUndo(t('已移除「{p0}」', { p0: host.label }), async () => {
      await repo.restoreHost(host);
      this.set({
        hosts: await repo.listHosts(),
        hostStatus: status ? { ...this.state.hostStatus, [url]: status } : this.state.hostStatus,
        models: modelsEntry ? { ...this.state.models, [url]: modelsEntry } : this.state.models,
      });
    }, async () => {
      // 確定移除：這支手機也忘掉權杖
      if (host.helperId) await this.forgetToken(host.helperId);
    });
  }

  // ---- 模型 ----

  /** 抓主機的模型清單與已載入的模型 */
  async loadModels(url: string): Promise<void> {
    const c = this.clientFor(url);
    this.set({ models: { ...this.state.models, [url]: { list: this.state.models[url]?.list ?? [], loading: true, error: '' } } });
    try {
      const [fetched, loaded] = await Promise.all([c.listModels(), c.loaded().catch(() => [] as LoadedModel[])]);
      const list = fetched.map((m) => (m.think && this.alwaysThink.has(`${url} ${m.name}`) ? { ...m, think: { kind: 'always' as const } } : m));
      this.set({
        models: { ...this.state.models, [url]: { list, loading: false, error: '' } },
        loaded: { ...this.state.loaded, [url]: loaded },
      });
      void this.loadHelperInfo(url);
      // 對話記得的模型如果原本沒有思考設定，補上預設值
      const s = this.state.session;
      if (s && s.hostUrl === url && s.model && s.think === null) {
        const info = list.find((m) => m.name === s.model);
        if (info?.think) await this.setThink(defaultThink(info));
      }
    } catch (e) {
      await this.notePairingLost(url, e);
      this.set({ models: { ...this.state.models, [url]: { list: [], loading: false, error: describeError(e), errorCode: e instanceof OllamaError ? e.code : '' } } });
    }
  }

  /** 小幫手說這支手機沒配對（被移除了）：忘掉權杖，畫面會改成「要重新配對」 */
  private async notePairingLost(url: string, e: unknown): Promise<void> {
    if (!(e instanceof OllamaError) || e.kind !== 'unpaired') return;
    const helperId = this.state.hosts.find((h) => h.url === url)?.helperId;
    if (helperId) await this.forgetToken(helperId);
  }

  async refreshLoaded(url: string): Promise<void> {
    try {
      const loaded = await this.clientFor(url).loaded();
      this.set({ loaded: { ...this.state.loaded, [url]: loaded } });
    } catch {
      // 查不到就維持原狀
    }
  }

  /** 這段對話改用某台主機的某個模型；也記成之後新對話的預設 */
  async selectModel(url: string, model: string): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    if (!s) return;
    const info = this.state.models[url]?.list.find((m) => m.name === model);
    const think = s.hostUrl === url && s.model === model ? s.think : defaultThink(info);
    await repo.updateSession(s.id, { hostUrl: url, model, think });
    await repo.setSetting(SETTING_LAST_HOST, url);
    await repo.setSetting(SETTING_LAST_MODEL, model);
    this.set({ session: { ...s, hostUrl: url, model, think }, context: null });
  }

  async setThink(think: ThinkSetting | null): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    await this.deps.repo.updateSession(s.id, { think });
    this.set({ session: { ...this.state.session!, think } });
  }

  async preload(url: string, model: string): Promise<void> {
    await this.clientFor(url).preload(model);
    await this.refreshLoaded(url);
  }

  async unload(url: string, model: string): Promise<void> {
    await this.clientFor(url).unload(model);
    await this.refreshLoaded(url);
  }

  /** 記下「一定會思考」的模型；模型清單與這段對話馬上改成一定思考 */
  private async markAlwaysThinks(url: string, model: string): Promise<void> {
    const key = `${url} ${model}`;
    if (this.alwaysThink.has(key)) return;
    this.alwaysThink.add(key);
    await this.deps.repo.setSetting(SETTING_ALWAYS_THINK, JSON.stringify([...this.alwaysThink]));
    const entry = this.state.models[url];
    if (entry) {
      const list = entry.list.map((m) => (m.name === model ? { ...m, think: { kind: 'always' as const } } : m));
      this.set({ models: { ...this.state.models, [url]: { ...entry, list } } });
    }
  }

  // ---- 連不到時找原因 ----

  /** 手機的 Wi-Fi 位址；沒連 Wi-Fi 是 null，問不到（逾時）是 undefined */
  private async phoneIp(): Promise<string | null | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.deps.wifiIp(),
        new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), WIFI_TIMEOUT_MS))),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 連不到電腦時找原因：手機沒連 Wi-Fi、不在同一個網路、電腦開著但小幫手沒開（馬上被拒絕）、電腦沒回應（睡著、關機、防火牆）。
   * 小幫手換了位址（路由器重新分配）就順便找到並改好。
   */
  async diagnose(url: string): Promise<Diagnosis> {
    const host = this.state.hosts.find((h) => h.url === url);
    const helper = !!host?.helperId;
    const started = Date.now();
    let refused = false;
    try {
      await this.clientFor(url).ping(helper, this.deps.probeTimeoutMs ?? 5000);
      return { kind: 'ok' };
    } catch (e) {
      // 有回應，只是回了錯誤：連線本身沒問題
      if (e instanceof OllamaError && (e.kind === 'http' || e.kind === 'server' || e.kind === 'unpaired')) return { kind: 'ok' };
      // 馬上被拒絕：電腦開著，只是那個連接埠沒有程式在聽；等到逾時是電腦沒回應
      refused = e instanceof OllamaError && e.kind === 'network' && Date.now() - started < 1500;
    }
    const ip = /^https?:\/\/([^:/]+)/.exec(url)?.[1] ?? '';
    if (isTailscaleIp(ip)) {
      // 透過 Tailscale 連的：手機的 Tailscale 沒開最常見；被拒絕代表連到電腦了，只是小幫手沒開
      const vpn = await this.deps.vpnOn?.().catch(() => null);
      if (vpn === false) return { kind: 'vpn-off' };
      return refused ? { kind: 'refused', helper } : { kind: 'vpn-no-response' };
    }
    const phone = await this.phoneIp();
    if (phone === null) return { kind: 'no-wifi' };
    if (host?.helperId && phone && this.tokens.has(host.helperId)) {
      await this.scanLan();
      const moved = this.state.hosts.find((h) => h.helperId === host.helperId && h.url !== url);
      if (moved) return { kind: 'moved', url: moved.url };
    }
    if (phone && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !sameSubnet(phone, ip)) return { kind: 'other-network', phoneIp: phone, hostIp: ip };
    return refused ? { kind: 'refused', helper } : { kind: 'no-response', helper };
  }

  // ---- 下載模型 ----

  private isHelper(url: string): boolean {
    return !!this.state.hosts.find((h) => h.url === url)?.helperId;
  }

  /** 問小幫手能下載到哪個引擎、電腦配備；順便接上還在下載中的工作（例如 App 重開） */
  async loadHelperInfo(url: string): Promise<void> {
    if (!this.isHelper(url)) {
      this.set({ helperInfo: { ...this.state.helperInfo, [url]: { downloadEngines: ['ollama'], hardware: null } } });
      return;
    }
    try {
      const info = await this.clientFor(url).helperInfo();
      this.set({ helperInfo: { ...this.state.helperInfo, [url]: info } });
      await this.syncDownloads(url);
    } catch {
      // 舊版小幫手或暫時連不到：下次再問
    }
  }

  private setDownloads(url: string, list: DownloadJob[]) {
    this.set({ downloads: { ...this.state.downloads, [url]: list } });
  }

  /** 跟小幫手拿下載進度；有下載中的就一直問，到全部結束為止 */
  private async syncDownloads(url: string): Promise<void> {
    if (this.polling.has(url)) return;
    this.polling.add(url);
    try {
      for (;;) {
        let list: DownloadJob[];
        try {
          list = await this.clientFor(url).downloads();
        } catch {
          return;
        }
        if (!this.state.hosts.some((h) => h.url === url)) return;
        const before = this.state.downloads[url] ?? [];
        this.setDownloads(url, list);
        const finished = list.filter((j) => j.status === 'done' && before.some((b) => b.id === j.id && b.status === 'downloading'));
        if (finished.length > 0) await this.downloadFinished(url, finished.map((j) => j.model));
        if (!list.some((j) => j.status === 'downloading')) return;
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 1000));
      }
    } finally {
      this.polling.delete(url);
    }
  }

  /** 下載好了：更新模型清單；這段對話還沒選模型就直接用它 */
  private async downloadFinished(url: string, names: string[]): Promise<void> {
    await this.loadModels(url);
    this.deps.onEvent?.('downloaded');
    const s = this.state.session;
    if (!s || s.model) return;
    const list = this.state.models[url]?.list ?? [];
    const m = list.find((x) => names.some((n) => x.name === n || x.name === `${n}:latest` || x.name.startsWith(`${n}@`)));
    if (m) await this.selectModel(url, m.name);
  }

  /**
   * 下載模型。透過小幫手：在電腦上下載，手機關掉也會繼續；
   * 直接連 Ollama：手機自己叫 Ollama 下載，App 要開著。
   */
  async startDownload(url: string, model: string): Promise<void> {
    // 同一個模型之前失敗、取消的紀錄先拿掉（重試不會一直疊上去）
    for (const j of (this.state.downloads[url] ?? []).filter((x) => x.model === model && x.status !== 'downloading')) await this.dismissDownload(url, j.id);
    const current = this.state.downloads[url] ?? [];
    if (this.isHelper(url)) {
      const job = await this.clientFor(url).startDownload(model, this.state.helperInfo[url]?.downloadEngines[0]);
      this.setDownloads(url, [...(this.state.downloads[url] ?? []).filter((j) => j.id !== job.id), job]);
      void this.syncDownloads(url);
      return;
    }
    if (current.some((j) => j.model === model && j.status === 'downloading')) return;
    const id = `local-${this.now()}`;
    const job: DownloadJob = { id, model, engine: 'ollama', status: 'downloading', completed: 0, total: 0, code: '', error: '', cancellable: true };
    const update = (patch: Partial<DownloadJob>) =>
      this.setDownloads(url, (this.state.downloads[url] ?? []).map((j) => (j.id === id ? { ...j, ...patch } : j)));
    this.setDownloads(url, [...current, job]);
    const controller = new AbortController();
    this.pullAborts.set(id, controller);
    let shownAt = 0;
    let total = 0;
    this.downloadTask = this.clientFor(url)
      .pull(
        model,
        (completed, all) => {
          total = all;
          // 進度一秒更新好幾次就夠了
          if (this.now() - shownAt < 250) return;
          shownAt = this.now();
          update({ completed, total });
        },
        controller.signal
      )
      .then(async () => {
        update({ status: 'done', completed: total, total });
        await this.downloadFinished(url, [model]);
      })
      .catch((e) => {
        if (e instanceof OllamaError && e.kind === 'cancelled') update({ status: 'cancelled' });
        else update({ status: 'failed', code: e instanceof OllamaError ? e.code : '', error: describeError(e) });
      })
      .finally(() => {
        this.pullAborts.delete(id);
      });
  }

  /** 取消下載中的工作 */
  async cancelDownload(url: string, id: string): Promise<void> {
    const local = this.pullAborts.get(id);
    if (local) {
      local.abort();
      return;
    }
    await this.clientFor(url).stopDownload(id);
    await this.syncDownloads(url);
  }

  /** 結束的工作從清單拿掉 */
  async dismissDownload(url: string, id: string): Promise<void> {
    this.setDownloads(url, (this.state.downloads[url] ?? []).filter((j) => j.id !== id));
    if (this.isHelper(url) && !id.startsWith('local-')) await this.clientFor(url).stopDownload(id).catch(() => {});
  }

  // ---- 對話 ----

  /** 開新對話；目前這段還沒講話就不另開。沿用目前的模型與思考設定 */
  async newSession(): Promise<void> {
    const { repo } = this.deps;
    // 不停掉回答：目前這段在背景照樣答完
    const s = this.state.session;
    if (s && this.state.messages.length === 0) return;
    const next = await repo.createSession({
      hostUrl: s?.hostUrl ?? null,
      model: s?.model ?? null,
      think: s?.think ?? null,
    });
    await repo.deleteEmptySessions(next.id);
    this.set({ session: next, messages: [], context: null, notice: '', threads: {}, streaming: null });
  }

  async openSession(id: string): Promise<void> {
    const { repo } = this.deps;
    // 點的就是目前這段：什麼都不用做（不要把回答停掉）
    if (this.state.session?.id === id) return;
    // 不停掉回答：原本那段在背景照樣答完；換到的這段如果正在回答，接著看它的串流
    const session = await repo.getSession(id);
    if (!session) return;
    const current = this.state.session;
    this.set({
      session,
      messages: await repo.listMessages(id),
      context: null,
      notice: '',
      threads: await this.threadMap(session),
      streaming: this.runs.get(id)?.streaming ?? null,
      fresh: this.state.fresh.filter((x) => x !== id),
    });
    if (current && current.id !== id) await repo.deleteEmptySessions(id);
    if (session.hostUrl && !this.state.models[session.hostUrl]) void this.loadModels(session.hostUrl);
  }

  /** 刪除對話：移到最近刪除（30 天內可以救回來），畫面上也可以馬上復原 */
  async deleteSession(id: string): Promise<void> {
    const { repo } = this.deps;
    const wasCurrent = this.state.session?.id === id;
    this.stopSession(id);
    // 上一個還能復原的操作先確定（例如清除全部資料）：不然它確定時會看到這段剛被移到最近刪除，直接永久刪掉
    await this.dismissUndo();
    const session = await repo.getSession(id);
    await repo.trashSessions([id]);
    // 刪的是討論串：回到它那段對話
    if (wasCurrent) await (session?.parentId ? this.openSession(session.parentId) : this.openLatestOrNew());
    await this.offerUndo(t('已刪除「{p0}」', { p0: session?.title || t('對話') }), async () => {
      await repo.restoreSessions([id]);
      await this.openSession(id);
    });
  }

  // ---- 討論串 ----

  /** 這段對話的討論串（討論串裡面不能再開，回空的） */
  private async threadMap(session: Session): Promise<ChatState['threads']> {
    if (session.parentId) return {};
    const out: ChatState['threads'] = {};
    for (const th of await this.deps.repo.threadsOf(session.id)) out[th.parentMessageId] = { id: th.id, count: th.count };
    return out;
  }

  /**
   * 針對某一題開討論串（已經開過就回到那一個）。點問題或回答都可以：帶進去的是那一題的問與答，
   * 不帶整段對話（不會越聊越長、不被別的主題干擾）。討論串裡不能再開（只有一層）
   */
  async openThread(messageId: string): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    if (!s || s.parentId || this.state.streaming) return;
    const msgs = this.state.messages;
    const i = msgs.findIndex((m) => m.id === messageId);
    if (i < 0) return;
    const qi = msgs[i].role === 'user' ? i : msgs.slice(0, i).map((m) => m.role).lastIndexOf('user');
    if (qi < 0) return;
    const question = msgs[qi];
    const existing = await repo.findThread(s.id, question.id);
    if (existing) return this.openSession(existing.id);
    // 那一題的回答：同一輪裡最後一則有字的（叫工具的那幾則跳過）；多 AI 討論帶那一輪每個人說的
    const next = msgs.findIndex((m, j) => j > qi && m.role === 'user');
    const said = msgs.slice(qi + 1, next < 0 ? undefined : next).filter((m) => m.role === 'assistant' && m.content.trim());
    const members = await repo.listMembers(s.id);
    const answers = members.length > 0 ? said : said.slice(-1);
    const thread = await repo.createSession({
      hostUrl: s.hostUrl,
      model: s.model,
      think: s.think,
      title: question.content.trim().slice(0, 40) || t('討論串'),
      parentId: s.id,
      parentMessageId: question.id,
    });
    await repo.addMessage(thread.id, {
      role: 'user',
      content: question.content,
      attachments: question.attachments.map(({ base64, width, height }) => ({ base64, width, height })),
      detail: THREAD_ROOT,
    });
    for (const a of answers) await repo.addMessage(thread.id, { role: 'assistant', content: a.content, model: a.model, hostLabel: a.hostLabel, detail: THREAD_ROOT, agentId: a.agentId });
    // 多 AI 討論的討論串：沿用原對話的成員
    for (const m of members) await repo.addMember(thread.id, m.agent.id, 'thread');
    await this.openSession(thread.id);
  }

  /** 從討論串回到它那段對話；什麼都沒問就回去的話，不留空的討論串 */
  async leaveThread(): Promise<void> {
    const s = this.state.session;
    if (!s?.parentId) return;
    const asked = this.state.messages.some((m) => m.role === 'user' && !isThreadRoot(m));
    await this.openSession(s.parentId);
    if (!asked) {
      await this.deps.repo.deleteSession(s.id);
      if (this.state.session?.id === s.parentId) this.set({ threads: await this.threadMap(this.state.session) });
    }
  }

  /** 最近刪除的對話 */
  listTrash() {
    return this.deps.repo.listTrash();
  }

  /** 從最近刪除救回來 */
  async restoreSession(id: string): Promise<void> {
    await this.deps.repo.restoreSessions([id]);
  }

  /** 最近刪除全部救回 */
  async restoreAllTrash(): Promise<void> {
    const ids = (await this.listTrash()).map((s) => s.id);
    if (ids.length > 0) await this.deps.repo.restoreSessions(ids);
  }

  /** 從最近刪除永久刪除（不能復原，畫面上要先確認） */
  async deleteForever(id: string): Promise<void> {
    await this.deps.repo.deleteSession(id);
  }

  /** 清空最近刪除（不能復原，畫面上要先確認） */
  async emptyTrash(): Promise<void> {
    await this.deps.repo.emptyTrash();
  }

  listSessions(search = '') {
    return this.deps.repo.listSessions(search);
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.deps.repo.updateSession(id, { title: title.trim() });
    if (this.state.session?.id === id) this.set({ session: { ...this.state.session, title: title.trim() } });
  }

  dismissNotice(): void {
    this.set({ notice: '' });
  }

  // ---- 傳送與回答 ----

  canAttachImages(): boolean {
    return !!this.currentModel()?.vision;
  }

  /** 確定目前的模型看不懂圖片（讀不到模型資訊時不下結論：可能只是電腦一時連不上，照常送，原因交給連線錯誤說） */
  private refusesImages(): boolean {
    const info = this.currentModel();
    return !!info && !info.vision;
  }

  /** 送出一則訊息並開始串流回答。照片只有模型看得懂圖時才能附 */
  /** 送出你說的話。多 AI 討論時 background＝true 只等訊息存好，討論在背景跑（畫面用，才能接著插話） */
  async send(text: string, images: Omit<Attachment, 'id'>[] = [], background = false): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    if (!s) return;
    // 多 AI 討論：大家在講的時候也可以插話
    const group = (await repo.listMembers(s.id)).length > 0;
    if (!group && this.state.streaming) return;
    if (!s.hostUrl || !s.model) throw new Error(t('請先選一個模型'));
    if (images.length > 0 && this.refusesImages()) throw new Error(t('這個模型看不懂圖片，不能附照片'));
    const content = text.trim() || (images.length > 0 ? defaultImageQuestion() : '');
    if (!content) return;
    await this.declinePending(s.id);
    await repo.addMessage(s.id, { role: 'user', content, attachments: images });
    this.set({ messages: await repo.listMessages(s.id), notice: '', suggestConclude: this.state.suggestConclude.filter((x) => x !== s.id) });
    if (!group) return this.answer();
    await this.joinMentioned(s.id, content);
    const run = this.runs.get(s.id);
    if (run) {
      run.interject = true;
      return;
    }
    const task = this.discuss(s.id, { mustReply: true });
    if (background) void task.catch(() => {});
    else await task;
  }

  /**
   * 重新產生某則回答：刪掉這則回答與之後的訊息，再問一次。
   * 有給 hostUrl／model 時先換成那個模型（換模型重新產生）。
   */
  async regenerate(assistantId: string, override?: { hostUrl: string; model: string }): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const target = this.state.messages.find((m) => m.id === assistantId && m.role === 'assistant' && !isThreadRoot(m));
    if (!s || !target || this.state.streaming || this.runs.has(s.id)) return;
    if (override) await this.selectModel(override.hostUrl, override.model);
    // 舊回答收成版本（可以用 ‹ › 切回來）；它後面的訊息先藏起來
    const later = await repo.softDeleteFrom(s.id, target.seq + 1);
    const group = await repo.hideAsVersion(target.id);
    this.set({ messages: await repo.listMessages(s.id), notice: '' });
    if (later.length > 0) {
      const before = new Set(this.state.messages.map((m) => m.id));
      await this.offerUndo(t('已刪掉後面的 {p0} 則訊息', { p0: later.length }), async () => {
        const added = (await repo.listMessages(s.id)).filter((m) => !before.has(m.id) && m.id !== target.id);
        for (const m of added) await repo.deleteMessage(m.id);
        await repo.showVersion(target.id);
        await repo.restoreMessages(later);
        if (this.state.session?.id === s.id) this.set({ messages: await repo.listMessages(s.id) });
      });
    }
    // 多 AI 討論裡某個 Agent 說的：請同一個人再講一次
    if (target.agentId) return this.discuss(s.id, { only: { agentId: target.agentId, replyTo: target.replyTo, altGroup: group } });
    await this.answer({ altGroup: group });
  }

  /** 切換回答版本（‹ ›）：delta = -1 上一個、+1 下一個 */
  async switchVersion(messageId: string, delta: number): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const m = this.state.messages.find((x) => x.id === messageId);
    if (!s || !m?.altGroup || this.state.streaming) return;
    const ids = await repo.versionIds(m.altGroup);
    const next = ids[ids.indexOf(m.id) + delta];
    if (!next) return;
    await repo.showVersion(next);
    this.set({ messages: await repo.listMessages(s.id) });
  }

  /** 編輯某則自己說的話並重送：這則和之後的訊息都換掉 */
  async editAndResend(userId: string, text: string, images: Omit<Attachment, 'id'>[] = []): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const target = this.state.messages.find((m) => m.id === userId && m.role === 'user' && !isThreadRoot(m));
    if (!s || !target || this.state.streaming) return;
    if (images.length > 0 && this.refusesImages()) throw new Error(t('這個模型看不懂圖片，不能附照片'));
    if (!text.trim() && images.length === 0) return;
    const before = new Set((await repo.listMessages(s.id)).map((m) => m.id));
    const old = await repo.softDeleteFrom(s.id, target.seq);
    this.set({ messages: await repo.listMessages(s.id) });
    await this.offerUndo(t('已取代原本的訊息'), async () => {
      this.stopSession(s.id);
      const added = (await repo.listMessages(s.id)).filter((m) => !before.has(m.id));
      for (const m of added) await repo.deleteMessage(m.id);
      await repo.restoreMessages(old);
      if (this.state.session?.id === s.id) this.set({ messages: await repo.listMessages(s.id) });
    });
    await this.send(text, images);
  }

  /** 最後一則是錯誤或「已停止」時，拿掉它（停止的話連半截回答一起拿掉）再問一次。「你按了復原」的紀錄行不算，看它上面那則 */
  async retry(): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const msgs = this.state.messages.filter((m) => !isRecordNote(m));
    const last = msgs.at(-1);
    if (!s || !last || this.state.streaming || (last.role !== 'error' && last.role !== 'note') || last.detail === CONCLUSION) return;
    if (!msgs.some((m) => m.role === 'user')) return;
    // 還有卡片等你按：先不問模型（跟 continueAfterTools 一樣）
    if (msgs.some((m) => m.actions?.some((a) => a.status === 'pending'))) return;
    if (this.runs.has(s.id)) return;
    await repo.deleteMessage(last.id);
    const before = msgs.at(-2);
    const group = (await repo.listMembers(s.id)).length > 0;
    // 多 AI 討論：停下來的那一則留著（是某個人說了一半），接著討論
    if (last.role === 'note' && before?.role === 'assistant' && !group) await repo.deleteMessage(before.id);
    this.set({ messages: await repo.listMessages(s.id), notice: '' });
    if (group) return this.discuss(s.id, { mustReply: true });
    await this.answer();
  }

  /** 某則訊息之後還有幾則（重新產生、編輯前提醒用） */
  laterCount(messageId: string): number {
    const i = this.state.messages.findIndex((m) => m.id === messageId);
    return i < 0 ? 0 : this.state.messages.length - i - 1;
  }

  /** 刪除單則訊息（可以復原） */
  async deleteMessage(id: string): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    // 討論串帶進去的那一題是背景，刪了 AI 就不知道在談什麼
    if (!s || this.state.streaming?.messageId === id || this.state.messages.some((m) => m.id === id && isThreadRoot(m))) return;
    await repo.softDeleteMessages([id]);
    this.set({ messages: await repo.listMessages(s.id) });
    await this.offerUndo(t('已刪除訊息'), async () => {
      await repo.restoreMessages([id]);
      if (this.state.session?.id === s.id) this.set({ messages: await repo.listMessages(s.id) });
    });
  }

  /** 每段對話正在跑的回答（同一段同時只有一個）；畫面用的 state.streaming 是目前這段的那一個 */
  private runs = new Map<string, Run>();

  /** 把正在跑的回答整理到畫面：哪幾段在回答、目前這段的串流 */
  private publishRuns(): void {
    const running: Record<string, string | null> = {};
    for (const [id, r] of this.runs) running[id] = r.parentId;
    const cur = this.state.session?.id;
    this.set({ running, streaming: (cur ? this.runs.get(cur)?.streaming : null) ?? null });
  }

  /** 中途停止回答（目前這段） */
  stop(): void {
    const cur = this.state.session?.id;
    if (cur) this.runs.get(cur)?.abort.abort();
  }

  /** 停掉某段對話（連它的討論串）在背景的回答：刪掉那段時用 */
  private stopSession(id: string): void {
    for (const [sid, r] of this.runs) if (sid === id || r.parentId === id) r.abort.abort();
  }

  /** 全部停掉：刪除所有對話、清除全部資料、從備份還原時用 */
  private stopAll(): void {
    for (const r of this.runs.values()) r.abort.abort();
  }

  /** 依目前對話內容向模型要一則新的回答（send、重新產生、編輯重送共用） */
  /**
   * 依某段對話（預設目前這段）的內容向模型要一則新的回答（send、重新產生、編輯重送、工具做完接著答共用）。
   * 換到別段對話、關掉討論串都不停：照樣在背景答完、存進那段；畫面只在還是同一段時更新
   */
  private async answer(options: { altGroup?: string; retried?: boolean; sessionId?: string } = {}): Promise<void> {
    const { repo } = this.deps;
    const s = options.sessionId ? await repo.getSession(options.sessionId) : this.state.session;
    if (!s?.hostUrl || !s.model || this.runs.has(s.id)) return;
    const here = () => this.state.session?.id === s.id;
    const url = s.hostUrl;
    const model = s.model;
    const info = this.state.models[url]?.list.find((m) => m.name === model);
    const tools = this.toolsFor(info);
    const msgs = await repo.listMessages(s.id);
    // 設定裡關掉的：模型還是可能照前面的對話去叫，所以先跟它說
    const toolsOff = info?.tools ? this.toolGroups().filter((g) => this.state.prefs.toolsOff?.includes(g)) : [];
    const { messages: history, droppedImages } = buildChatMessages(msgs, {
      vision: info ? info.vision : true,
      systemPrompt:
        REPLY_PROMPTS[this.appLanguage()] +
        (tools.length > 0 ? '\n\n' + toolSystemPrompt(this.now(), this.timeZone()) : '') +
        (toolsOff.length > 0 ? '\n\n' + toolsOffPrompt(toolsOff) : ''),
    });
    // 這一輪使用者說「不要」、改過才做的：最後再提醒一次，不然模型常照自己原本提的講（「已經改好了」、原本的日期）
    const note = this.lastRoundNote(msgs);
    if (note) history.push({ role: 'system', content: note });
    if (droppedImages > 0 && here()) this.set({ notice: t('目前的模型看不懂圖片，前面的 {p0} 張照片這次不會送出。', { p0: droppedImages }) });

    const hostLabel = this.hostLabel(url);
    const placeholder = await repo.addMessage(s.id, { role: 'assistant', content: '', model, hostLabel, altGroup: options.altGroup ?? null });
    const abort = new AbortController();
    const run = { abort, parentId: s.parentId, streaming: { messageId: placeholder.id, content: '', thinking: '', startedAt: this.now(), phase: 'waiting' } as Streaming };
    this.runs.set(s.id, run);
    if (here()) this.set({ messages: [...this.state.messages, placeholder] });
    this.publishRuns();
    const update = (patch: Partial<Streaming>) => {
      if (this.runs.get(s.id) !== run) return;
      run.streaming = { ...run.streaming, ...patch };
      if (here()) this.set({ streaming: run.streaming });
    };

    // 串流的字先累積，固定間隔才更新畫面
    let content = '';
    let thinking = '';
    const sentThink = thinkToSend(info, s.think);
    // 這個模型會思考但這次沒開：注意它是不是還是先想了（一定會思考的模型）
    const mayLeak = !!info?.think && !sentThink;
    let raw = '';
    let leaked = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const allThinking = thinking + leaked;
      update({ content, thinking: allThinking, phase: content ? 'answering' : allThinking ? 'thinking' : 'waiting' });
    };

    const signal = abort.signal;
    // 同時確認連不連得到：根本連不到時馬上停下來找原因，不用等到聊天逾時（最多 3 分鐘）
    let unreachable = false;
    const isHelper = !!this.state.hosts.find((h) => h.url === url)?.helperId;
    this.clientFor(url)
      .ping(isHelper, this.deps.probeTimeoutMs ?? 5000)
      .catch((e) => {
        if (e instanceof OllamaError && (e.kind === 'network' || e.kind === 'timeout') && !content && !thinking && this.runs.get(s.id) === run) {
          unreachable = true;
          abort.abort();
        }
      });
    // 模型載入了沒：沒有的話畫面說明第一次比較久
    this.clientFor(url)
      .loaded()
      .then((list) => update({ loading: !list.some((m) => m.name === model) }))
      .catch(() => {});
    let retryMoved = false;
    let next: 'continue' | 'wait' | 'done' = 'done';
    try {
      const result = await this.clientFor(url).chat(
        { model, messages: history, think: sentThink, ...(tools.length > 0 ? { tools: toOllamaTools(tools) } : {}) },
        (d) => {
          if (d.thinking) thinking += d.thinking;
          if (d.content) {
            raw += d.content;
            content = raw;
            // 沒開思考，模型卻還是先想（一定會思考的模型）：把想的部分搬到思考裡
            const split = mayLeak ? splitThink(raw) : null;
            if (split) {
              leaked = split.thinking;
              content = split.content;
            }
          }
          if (!timer) timer = setTimeout(flush, this.throttleMs);
        },
        signal
      );
      const stats = {
        evalCount: result.evalCount,
        evalDurationNs: result.evalDurationNs,
        promptEvalCount: result.promptEvalCount,
        totalDurationNs: result.totalDurationNs,
      };
      thinking += leaked;
      // 全部關掉時也要接：模型照前面的對話還是會叫，丟掉的話回答就是空的
      const toolCalls = tools.length > 0 || toolsOff.length > 0 ? result.toolCalls : [];
      await repo.updateMessage(placeholder.id, { content, thinking, stats, ...(toolCalls.length > 0 ? { toolCalls } : {}) });
      if (leaked) await this.markAlwaysThinks(url, model);
      const limit = await this.contextLimit(url, model);
      const used = result.promptEvalCount + result.evalCount;
      if (here()) this.set({ context: { used, limit, level: contextLevel(used, limit) } });
      // AI 要叫工具：只讀的直接做，會改東西的等使用者確認
      if (toolCalls.length > 0) next = await this.runToolCalls(s.id, placeholder.id, toolCalls);
      // 在背景答完的不震、不播報（使用者正在看別段，不要打擾）
      else if (here()) this.deps.onEvent?.('answered');
      // 有文字的回答出來、這段還沒有標題：請模型取標題（不擋住下一次輸入；第一個回答被停掉的話，下一個回答再取）
      const answered = (await repo.listMessages(s.id)).filter((m) => m.role === 'assistant' && m.content.trim()).length;
      if (answered >= 1 && !(await repo.getSession(s.id))?.title) this.titleTask = this.autoTitle(s.id, url, model, info);
    } catch (e) {
      await this.notePairingLost(url, e);
      const cancelled = e instanceof OllamaError && e.kind === 'cancelled' && !unreachable;
      const offline = unreachable || (e instanceof OllamaError && e.kind === 'network' && !content && !thinking);
      thinking += leaked;
      if (content || thinking) {
        await repo.updateMessage(placeholder.id, { content, thinking });
      } else {
        await repo.deleteMessage(placeholder.id);
      }
      let reason = describeError(e);
      if (offline) {
        const d = await this.diagnose(url);
        if (d.kind === 'moved' && !options.retried) retryMoved = true;
        else if (d.kind !== 'ok') reason = diagnosisText(d);
      }
      if (retryMoved) {
        if (here()) this.set({ notice: diagnosisText({ kind: 'moved', url: '' }) });
      } else {
        await repo.addMessage(
          s.id,
          cancelled ? { role: 'note', content: t('已停止') } : { role: 'error', content: t('沒有得到回答：{p0}', { p0: reason }), detail: errorDetail(e) }
        );
        if (here()) this.deps.onEvent?.(cancelled ? 'stopped' : 'failed');
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.runs.get(s.id) === run) this.runs.delete(s.id);
      const latest = await repo.listMessages(s.id);
      if (here()) this.set({ messages: latest });
      this.publishRuns();
      // 討論串在背景答完：入口寫「新回答」（打開看過就拿掉）；目前看的是它那段對話時，順便更新問了幾次
      if (s.parentId && !here()) {
        if (!this.state.fresh.includes(s.id)) this.set({ fresh: [...this.state.fresh, s.id] });
        if (this.state.session?.id === s.parentId) this.set({ threads: await this.threadMap(this.state.session) });
      }
      void this.refreshLoaded(url);
    }
    // 按了停止（不是連不到）：不再接著問模型
    if (signal.aborted && !unreachable) {
      if (next === 'continue') {
        await repo.addMessage(s.id, { role: 'note', content: t('已停止') });
        const after = await repo.listMessages(s.id);
        if (here()) this.set({ messages: after });
        if (here()) this.deps.onEvent?.('stopped');
      }
      return;
    }
    // 電腦換了位址：已經改好，自動再問一次（換到別段也照樣在背景問）
    if (retryMoved) await this.answer({ ...options, retried: true, sessionId: s.id });
    // 工具都做完了（不用等使用者）：把結果交回模型，接著回答
    else if (next === 'continue') await this.continueAfterTools(s.id);
  }

  // ---- Agent（設定頁） ----

  /** 讀「我的 Agent」 */
  async loadMyAgents(): Promise<Agent[]> {
    const list = await this.deps.repo.listMyAgents();
    this.set({ myAgents: list });
    return list;
  }

  /** 一句話生成角色卡（用目前對話的模型）；avoid 是上一個生成的名字（「再生一個」不要一樣） */
  async generateAgent(idea: string, avoid?: string): Promise<AgentDraft> {
    const s = this.state.session;
    const m = s ? this.modelFor(null, s) : null;
    if (!m) throw new Error(t('請先選一個模型'));
    const text = await this.collect(m.url, m.model, agentDraftMessages(idea, avoid), {
      think: quickThink(m.info),
      format: AGENT_DRAFT_SCHEMA,
      options: { temperature: avoid ? 0.9 : 0.6, num_predict: 600 },
    });
    let v: any = {};
    try {
      v = JSON.parse((m.info?.think ? (splitThink(text)?.content ?? text) : text).match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    } catch {
      // 不是 JSON：下面檢查
    }
    const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
    if (!str(v.name)) throw new Error(t('AI 沒有生成角色，換個說法再試一次。'));
    return {
      name: str(v.name).slice(0, 30),
      intro: str(v.intro),
      emoji: str(v.emoji) || '🙂',
      talk: Math.max(0, Math.min(1, Number(v.talk) || 0.5)),
      card: { expertise: str(v.expertise), stance: str(v.stance), style: str(v.style), blindSpot: str(v.blindSpot) },
    };
  }

  /** 存自己建的 Agent（新的或改過的），放進「我的 Agent」 */
  async saveAgent(draft: Partial<Omit<Agent, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>> & { name: string }, id?: string): Promise<Agent> {
    const { repo } = this.deps;
    let a: Agent;
    if (id) {
      await repo.updateAgent(id, { ...draft, mine: true });
      a = (await repo.getAgent(id))!;
    } else {
      a = await repo.createAgent({ ...draft, mine: true });
    }
    await this.loadMyAgents();
    if (this.state.agents[a.id] || this.state.members.some((m) => m.agent.id === a.id)) await this.refreshGroup();
    return a;
  }

  /** 圖鑑的 Agent 加到「我的 Agent」（用過的沿用同一份，筆記接得上） */
  async addCatalogToMine(catalogId: string): Promise<Agent | null> {
    const e = getEntry(catalogId);
    if (!e) return null;
    const a = await this.deps.repo.agentFromCatalog(catalogId, { name: entryName(e), intro: entryIntro(e), emoji: e.e });
    await this.deps.repo.updateAgent(a.id, { mine: true });
    await this.loadMyAgents();
    return (await this.deps.repo.getAgent(a.id))!;
  }

  /** 刪掉 Agent（說過的話照樣看得到名字），幾秒內可以復原 */
  async deleteAgent(id: string): Promise<void> {
    const { repo } = this.deps;
    const a = await repo.getAgent(id);
    if (!a) return;
    await repo.deleteAgent(id);
    await this.loadMyAgents();
    await this.offerUndo(t('已刪除「{p0}」', { p0: a.name }), async () => {
      await repo.restoreAgent(id, a.mine);
      await this.loadMyAgents();
    });
  }

  /** 圖鑑某個 Agent 的角色原文（跟著 App 語言） */
  catalogPrompt(catalogId: string): Promise<string> {
    return this.prompts.get(catalogId);
  }

  /** Agent 實際用的角色說明（改過的原文、圖鑑原文或角色卡） */
  agentRole(a: Agent): Promise<string> {
    return this.roleFor(a);
  }

  listNotes(agentId: string): Promise<AgentNote[]> {
    return this.deps.repo.listNotes(agentId);
  }

  async deleteNote(id: string): Promise<void> {
    await this.deps.repo.deleteNote(id);
  }

  async clearNotes(agentId: string): Promise<void> {
    await this.deps.repo.clearNotes(agentId);
  }

  // ---- 多 AI 討論 ----

  /** 把某個 Agent 加進目前這段對話 */
  async addMember(agentId: string): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    await this.deps.repo.addMember(s.id, agentId, 'user');
    await this.refreshGroup();
  }

  /** 從圖鑑直接加進目前這段對話（沒有先加到「我的 Agent」） */
  async addCatalogMember(catalogId: string, fields: Pick<Agent, 'name' | 'intro' | 'emoji'>): Promise<void> {
    const a = await this.deps.repo.agentFromCatalog(catalogId, fields);
    await this.addMember(a.id);
  }

  async removeMember(agentId: string): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    await this.deps.repo.removeMember(s.id, agentId);
    await this.refreshGroup();
  }

  /** 改目前這段對話的群組設定（發言方式、讓 AI 自己加入、連續上限、全自動） */
  async setGroupSettings(patch: Partial<GroupSettings>): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    const group = { ...DEFAULT_GROUP, ...s.group, ...patch };
    await this.deps.repo.updateSession(s.id, { group });
    this.set({ session: { ...s, group } });
  }

  /** 沒人想講停下來之後，讓 AI 接著聊（你不用說話） */
  async continueDiscussion(): Promise<void> {
    const s = this.state.session;
    if (!s || this.runs.has(s.id)) return;
    this.set({ suggestConclude: this.state.suggestConclude.filter((x) => x !== s.id) });
    await this.discuss(s.id, { mustReply: true });
  }

  /** 長按某個 Agent 的話「請他展開講」：他完整說明那一則，不限長度 */
  async expandMessage(messageId: string): Promise<void> {
    const s = this.state.session;
    const m = this.state.messages.find((x) => x.id === messageId);
    if (!s || !m?.agentId || this.runs.has(s.id)) return;
    await this.discuss(s.id, { only: { agentId: m.agentId, replyTo: m.id, expand: true } });
  }

  /** 「幫我挑」：照話題從圖鑑挑 3–4 個觀點互補的角色（模型先想要哪些職稱，再到圖鑑裡找） */
  async suggestMembers(topic: string): Promise<CatalogEntry[]> {
    const s = this.state.session;
    const m = s ? this.modelFor(null, s) : null;
    if (!m) throw new Error(t('請先選一個模型'));
    const text = await this.collect(m.url, m.model, pickRolesMessages(topic), {
      think: quickThink(m.info),
      format: PICK_ROLES_SCHEMA,
      options: { temperature: 0.5, num_predict: 300 },
    });
    let roles: { zh?: string; en?: string }[] = [];
    try {
      roles = JSON.parse((m.info?.think ? (splitThink(text)?.content ?? text) : text).match(/\{[\s\S]*\}/)?.[0] ?? '{}').roles ?? [];
    } catch {
      roles = [];
    }
    const members = new Set(this.state.members.flatMap((x) => (x.agent.catalogId ? [x.agent.catalogId] : [])));
    const picked: CatalogEntry[] = [];
    for (const r of roles) {
      for (const q of [r.zh, r.en]) {
        const hit = q?.trim() ? searchCatalog(q.trim()).find((e) => !members.has(e.id) && !picked.includes(e)) : undefined;
        if (hit) {
          picked.push(hit);
          break;
        }
      }
    }
    if (picked.length === 0) throw new Error(t('沒有挑到合適的角色，換個說法再試一次。'));
    return picked.slice(0, 4);
  }

  /**
   * 收尾：整理者列出要決定的問題和 2–4 個方案、每個成員同時投一票（附理由）、寫結論卡（共識、分歧、待辦），
   * 結論卡釘在對話最上面；最後每個 Agent 寫自己的筆記（下次討論帶著）
   */
  async conclude(sessionId = this.state.session?.id): Promise<void> {
    const { repo } = this.deps;
    if (!sessionId || this.runs.has(sessionId)) return;
    const s = await repo.getSession(sessionId);
    const sm = s ? this.modelFor(null, s) : null;
    const members = await repo.listMembers(sessionId);
    if (!s || !sm || members.length === 0) return;
    const abort = new AbortController();
    const signal = abort.signal;
    const run: Run = { abort, streaming: null, parentId: s.parentId, phase: null };
    this.runs.set(sessionId, run);
    this.publishRuns();
    this.set({ suggestConclude: this.state.suggestConclude.filter((x) => x !== sessionId) });
    this.setPhase(sessionId, run, { phase: 'concluding', agentId: null });
    const json = (text: string, info: ModelInfo | undefined): any => {
      try {
        return JSON.parse((info?.think ? (splitThink(text)?.content ?? text) : text).match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      } catch {
        return {};
      }
    };
    const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()).slice(0, max) : []);
    try {
      const names = new Map(members.map((m) => [m.agent.id, m.agent.name]));
      const lines = toLines(await repo.listMessages(sessionId), names);
      // 1. 要決定什麼、有哪些方案
      const o = json(await this.collect(sm.url, sm.model, optionsMessages(lines, s.summary), { think: quickThink(sm.info), format: OPTIONS_SCHEMA, options: { num_predict: 500 }, signal }), sm.info);
      let options = strings(o.options, 4);
      if (options.length < 2) options = [t('同意目前的結論'), t('不同意')];
      const question = typeof o.question === 'string' && o.question.trim() ? o.question.trim() : t('結論是什麼？');
      // 2. 每個人同時投票
      const card: Conclusion = { question, options: options.map((text) => ({ text, votes: [] })), consensus: '', disagreements: [], todos: [] };
      await Promise.all(
        members.map(async (m) => {
          const mm = this.modelFor(m.agent, s);
          if (!mm) return;
          try {
            const v = json(await this.collect(mm.url, mm.model, voteMessages(this.toSpeaker(m), question, options, lines, s.summary), { think: quickThink(mm.info), format: VOTE_SCHEMA, options: { num_predict: 200 }, signal }), mm.info);
            const i = Math.round(Number(v.choice)) - 1;
            if (i >= 0 && i < options.length) card.options[i].votes.push({ who: m.agent.id, name: m.agent.name, reason: typeof v.reason === 'string' ? v.reason.trim() : '' });
          } catch {
            // 這個人沒投到：結論照樣寫
          }
        })
      );
      if (signal.aborted) throw new OllamaError('cancelled', t('已取消。'));
      // 3. 結論卡
      const c = json(await this.collect(sm.url, sm.model, conclusionMessages(card, lines, s.summary), { think: quickThink(sm.info), format: CONCLUSION_SCHEMA, options: { num_predict: 800 }, signal }), sm.info);
      card.consensus = typeof c.consensus === 'string' ? c.consensus.trim() : '';
      card.disagreements = strings(c.disagreements, 3);
      card.todos = strings(c.todos, 4);
      const msg = await repo.addMessage(sessionId, { role: 'note', content: JSON.stringify(card), detail: CONCLUSION });
      await repo.updateSession(sessionId, { pinnedId: msg.id });
      if (this.state.session?.id === sessionId) {
        this.set({ session: (await repo.getSession(sessionId)) ?? this.state.session, messages: await repo.listMessages(sessionId) });
        this.deps.onEvent?.('answered');
      }
      // 4. 每個人寫筆記（下次討論帶著）
      await Promise.all(
        members.map(async (m) => {
          const mm = this.modelFor(m.agent, s);
          if (!mm) return;
          try {
            const text = await this.collect(mm.url, mm.model, noteMessages(this.toSpeaker(m), card, lines), { think: quickThink(mm.info), options: { num_predict: 250 }, signal });
            const note = (mm.info?.think ? (splitThink(text)?.content ?? text) : text).trim().slice(0, 400);
            if (note) await repo.addNote(m.agent.id, sessionId, note);
          } catch {
            // 沒寫到筆記不影響結論
          }
        })
      );
    } catch (e) {
      if (signal.aborted) await repo.addMessage(sessionId, { role: 'note', content: t('已停止') });
      else await this.discussionError(sessionId, e);
    } finally {
      this.setPhase(sessionId, run, null);
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
      this.publishRuns();
      if (this.state.session?.id === sessionId) this.set({ messages: await repo.listMessages(sessionId) });
    }
  }

  /** 在結論卡上投你的一票（再投一次是換票） */
  async voteConclusion(messageId: string, index: number): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const m = this.state.messages.find((x) => x.id === messageId && x.detail === CONCLUSION);
    const card = m ? parseConclusion(m.content) : null;
    if (!s || !m || !card || !card.options[index]) return;
    for (const o of card.options) o.votes = o.votes.filter((v) => v.who !== 'user');
    card.options[index].votes.push({ who: 'user', name: t('你'), reason: '' });
    await repo.updateMessage(messageId, { content: JSON.stringify(card) });
    this.set({ messages: await repo.listMessages(s.id) });
  }

  /** 結論卡釘在最上面／取消釘選 */
  async pinConclusion(messageId: string | null): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    await this.deps.repo.updateSession(s.id, { pinnedId: messageId });
    this.set({ session: { ...s, pinnedId: messageId } });
  }

  /** 不收尾（關掉「要收尾嗎？」） */
  dismissConclude(): void {
    const s = this.state.session;
    if (s) this.set({ suggestConclude: this.state.suggestConclude.filter((x) => x !== s.id) });
  }

  /** 目前這段對話的成員、訊息上要顯示的 Agent */
  private async refreshGroup(): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    if (!s) return;
    const members = await repo.listMembers(s.id);
    const msgs = this.state.messages.length ? this.state.messages : await repo.listMessages(s.id);
    const ids = new Set<string>([...members.map((m) => m.agent.id), ...msgs.flatMap((m) => (m.agentId ? [m.agentId] : []))]);
    const agents: Record<string, Agent> = {};
    for (const a of await repo.agentsByIds([...ids])) agents[a.id] = a;
    if (this.state.session?.id !== s.id) return;
    this.set({ members, agents });
  }

  /** 對話裡用的那一份 Agent（從圖鑑來的沿用同一份，筆記才接得上） */
  private toSpeaker = (m: Member | Agent, position = 0): Speaker => {
    const a = 'agent' in m ? m.agent : m;
    return { id: a.id, name: a.name, intro: a.intro, talk: a.talk, position: 'agent' in m ? m.position : position };
  };

  /** Agent 的角色說明：改過的原文、圖鑑原文、角色卡，依序找 */
  private async roleFor(a: Agent): Promise<string> {
    if (a.prompt) return a.prompt;
    if (a.catalogId) {
      try {
        const p = await this.prompts.get(a.catalogId);
        if (p) return p;
      } catch {
        // 讀不到原文就用角色卡
      }
    }
    return cardPrompt(a.name, a.intro, a.card);
  }

  /** Agent 用哪台電腦、哪個模型（沒指定就跟著對話） */
  private modelFor(a: Agent | null, s: Session): { url: string; model: string; info: ModelInfo | undefined } | null {
    const url = a?.hostUrl ?? s.hostUrl;
    const model = a?.model ?? s.model;
    if (!url || !model) return null;
    return { url, model, info: this.state.models[url]?.list.find((m) => m.name === model) };
  }

  /** 模型實際能放的上下文：載入了就照實際的，還沒載入就保守估 */
  private async runtimeContext(url: string, model: string): Promise<number> {
    const limit = await this.contextLimit(url, model);
    const loaded = this.state.loaded[url]?.find((m) => m.name === model)?.contextLength;
    return loaded ?? Math.min(limit ?? ASSUMED_CONTEXT, ASSUMED_CONTEXT);
  }

  /** 不串流到畫面的小呼叫：把回答收成一段文字 */
  private async collect(url: string, model: string, messages: ChatMessage[], opts: { think?: ThinkSetting; format?: unknown; options?: Record<string, unknown>; signal?: AbortSignal }): Promise<string> {
    let text = '';
    await this.clientFor(url).chat({ model, messages, think: opts.think, format: opts.format, options: opts.options }, (d) => (text += d.content ?? ''), opts.signal);
    return text;
  }

  private setPhase(sessionId: string, run: Run, phase: DiscussionPhase | null): void {
    run.phase = phase;
    if (this.state.session?.id === sessionId) this.set({ discussion: phase });
  }

  /** 訊息裡 @ 了「我的 Agent」但還不是成員的：拉進來 */
  private async joinMentioned(sessionId: string, text: string): Promise<void> {
    const { repo } = this.deps;
    if (!text.includes('@')) return;
    const members = new Set((await repo.listMembers(sessionId)).map((m) => m.agent.id));
    const mine = (await repo.listMyAgents()).filter((a) => !members.has(a.id));
    for (const id of findMentions(text, mine)) await this.joinAgent(sessionId, mine.find((a) => a.id === id)!, 'mention');
  }

  /** 加進討論，畫面上記一行「某某加入了討論」 */
  private async joinAgent(sessionId: string, a: Agent, by: 'auto' | 'mention'): Promise<void> {
    const { repo } = this.deps;
    await repo.addMember(sessionId, a.id, by);
    await repo.addMessage(sessionId, { role: 'note', content: t('{p0} 加入了討論', { p0: a.name }), detail: RECORD_NOTE });
    if (this.state.session?.id === sessionId) {
      this.set({ messages: await repo.listMessages(sessionId) });
      await this.refreshGroup();
    }
  }

  /** 有成員的對話：大家輪流講到沒人想講、到連續上限、你按暫停為止 */
  private async discuss(
    sessionId: string,
    opts: { mustReply?: boolean; only?: { agentId: string; replyTo: string | null; expand?: boolean; altGroup?: string } } = {}
  ): Promise<void> {
    const { repo } = this.deps;
    if (this.runs.has(sessionId)) return;
    const first = await repo.getSession(sessionId);
    if (!first) return;
    const abort = new AbortController();
    const run: Run = { abort, streaming: null, parentId: first.parentId, phase: null };
    this.runs.set(sessionId, run);
    this.publishRuns();
    let mustReply = !!opts.mustReply;
    let streak = 0;
    let suggest = false;
    let reason: StopReason = 'quiet';
    try {
      for (;;) {
        if (abort.signal.aborted) {
          reason = 'stopped';
          break;
        }
        const s = await repo.getSession(sessionId);
        const members = await repo.listMembers(sessionId);
        if (!s || members.length === 0) break;
        const group = s.group ?? DEFAULT_GROUP;
        // 你在中途插話：重新算連續幾則，一定有人回你
        if (run.interject) {
          run.interject = false;
          mustReply = true;
          streak = 0;
        }
        if (opts.only) {
          if (streak > 0) break;
        } else if (!mustReply && streak >= group.maxStreak) {
          reason = 'cap';
          break;
        }
        const msgs = await repo.listMessages(sessionId);
        const names = new Map(members.map((m) => [m.agent.id, m.agent.name]));
        for (const id of msgs.flatMap((m) => (m.agentId && !names.has(m.agentId) ? [m.agentId] : []))) names.set(id, this.state.agents[id]?.name ?? (await repo.getAgent(id))?.name ?? 'AI');
        const lines = toLines(msgs, names);
        const pick = opts.only
          ? { id: opts.only.agentId, replyTo: opts.only.replyTo, outsider: null as Agent | null }
          : await this.pickSpeaker(s, group, members, lines, mustReply, streak, run, (v) => (suggest = v));
        if (abort.signal.aborted) {
          reason = 'stopped';
          break;
        }
        if (pick === 'error') {
          reason = 'error';
          break;
        }
        if (!pick) break;
        if (pick.outsider) await this.joinAgent(sessionId, pick.outsider, 'auto');
        const speaker = members.find((m) => m.agent.id === pick.id)?.agent ?? pick.outsider ?? (await repo.getAgent(pick.id));
        if (!speaker) break;
        const ok = await this.speak(sessionId, speaker, pick.replyTo, run, { expand: opts.only?.expand, altGroup: opts.only?.altGroup });
        if (!ok) {
          reason = abort.signal.aborted ? 'stopped' : 'error';
          break;
        }
        streak++;
        mustReply = false;
      }
    } finally {
      this.setPhase(sessionId, run, null);
      if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
      this.publishRuns();
      if (this.state.session?.id === sessionId) {
        this.set({ messages: await repo.listMessages(sessionId) });
        await this.refreshGroup();
      }
      if (first.parentId && this.state.session?.id !== sessionId && !this.state.fresh.includes(sessionId)) this.set({ fresh: [...this.state.fresh, sessionId] });
    }
    // 自然停下來（沒人想講、到上限）：全自動就直接收尾；不然 AI 覺得差不多了就提議收尾
    const naturally = (reason === 'quiet' || reason === 'cap') && !opts.only && streak > 0;
    if (naturally && (await repo.getSession(sessionId))?.group?.autopilot) await this.conclude(sessionId);
    else if (naturally && suggest && !this.state.suggestConclude.includes(sessionId)) {
      this.set({ suggestConclude: [...this.state.suggestConclude, sessionId] });
    }
    if (reason === 'quiet' && this.state.session?.id === sessionId && streak > 0) this.deps.onEvent?.('answered');
    // 有人講過話、還沒有標題：取一個
    const after = await repo.getSession(sessionId);
    const sm = after ? this.modelFor(null, after) : null;
    if (streak > 0 && after && !after.title && sm) this.titleTask = this.autoTitle(sessionId, sm.url, sm.model, sm.info);
  }

  /** 選下一個發言的人：@ 到的先講，再照發言方式；回 null 是沒人要講 */
  private async pickSpeaker(
    s: Session,
    group: GroupSettings,
    members: Member[],
    lines: Line[],
    mustReply: boolean,
    streak: number,
    run: Run,
    onSuggest: (v: boolean) => void
  ): Promise<{ id: string; replyTo: string | null; outsider: Agent | null } | null | 'error'> {
    const speakers = members.map((m) => this.toSpeaker(m));
    const last = lines.at(-1);
    const lastSpeaker = last?.who && last.who !== 'ai' ? last.who : null;
    const lastAgent = [...lines].reverse().find((l) => l.who && l.who !== 'ai')?.who ?? null;
    const mentioned = last ? findMentions(last.content, speakers).filter((id) => id !== lastSpeaker) : [];
    // 回哪一則：那個人最近說的；沒說要回誰時，你剛說完就回你
    const replyId = (name: string, self: string): string | null => {
      const n = name.trim().toLowerCase();
      const hit = n ? [...lines].reverse().find((l) => l.who !== self && l.name.toLowerCase() === n.replace(/^@/, '')) : undefined;
      return hit?.id ?? (last && last.who !== self && last.who === null ? last.id : null);
    };
    if (mentioned[0]) return { id: mentioned[0], replyTo: last!.id, outsider: null };
    if (members.length === 1) return mustReply ? { id: speakers[0].id, replyTo: replyId('', speakers[0].id), outsider: null } : null;
    if (group.mode === 'mention') {
      if (!mustReply) return null;
      const id = lastAgent ?? speakers[0].id;
      return { id, replyTo: replyId('', id), outsider: null };
    }
    if (group.mode === 'round') {
      if (streak >= members.length) return null;
      const next = nextInRound(speakers, lastAgent);
      return next ? { id: next.id, replyTo: replyId('', next.id), outsider: null } : null;
    }
    const sm = this.modelFor(null, s);
    if (!sm) return null;
    if (group.mode === 'host') {
      this.setPhase(s.id, run, { phase: 'hosting', agentId: null });
      try {
        const text = await this.collect(sm.url, sm.model, hostMessages(speakers, lines), { think: quickThink(sm.info), format: HOST_SCHEMA, options: { num_predict: 120 }, signal: run.abort.signal });
        const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        onSuggest(json.conclude === true);
        const id = idByName(String(json.next ?? ''), speakers) ?? (mustReply ? (nextInRound(speakers, lastAgent)?.id ?? null) : null);
        return id ? { id, replyTo: replyId(String(json.reply_to ?? ''), id), outsider: null } : null;
      } catch (e) {
        if (run.abort.signal.aborted) return null;
        return this.discussionError(s.id, e);
      }
    }
    // 自由搶話：每個人同時舉手
    this.setPhase(s.id, run, { phase: 'bidding', agentId: null });
    const outsiders = group.autoJoin
      ? (await this.deps.repo.listMyAgents()).filter((a) => a.autoJoin && !members.some((m) => m.agent.id === a.id)).slice(0, MAX_OUTSIDERS)
      : [];
    const people = [...speakers.map((p) => ({ ...p, member: true })), ...outsiders.map((a, i) => ({ ...this.toSpeaker(a, members.length + i), member: false }))];
    const errors: unknown[] = [];
    const bids = await Promise.all(
      people.map(async (p): Promise<Bid> => {
        const agent = p.member ? members.find((m) => m.agent.id === p.id)!.agent : outsiders.find((a) => a.id === p.id)!;
        const m = this.modelFor(agent, s);
        if (!m) return { id: p.id, score: 0, replyTo: '', conclude: false };
        try {
          const text = await this.collect(m.url, m.model, bidMessages(p, speakers, lines, !p.member), {
            think: quickThink(m.info),
            format: BID_SCHEMA,
            options: { num_predict: 80, temperature: 0.4 },
            signal: run.abort.signal,
          });
          return parseBid(p.id, m.info?.think ? (splitThink(text)?.content ?? text) : text);
        } catch (e) {
          errors.push(e);
          return { id: p.id, score: 0, replyTo: '', conclude: false };
        }
      })
    );
    if (run.abort.signal.aborted) return null;
    // 成員全部問不到（電腦沒開、模型不見了）：說原因，不要默默停下來
    if (errors.length >= speakers.length && errors.length === people.length) return this.discussionError(s.id, errors[0]);
    onSuggest(wantsConclusion(bids, new Set(speakers.map((p) => p.id))));
    const chosen = chooseSpeaker(bids, people, { lastSpeaker, mentioned: [], mustReply });
    if (!chosen) return null;
    return { id: chosen.id, replyTo: replyId(chosen.replyTo, chosen.id), outsider: outsiders.find((a) => a.id === chosen.id) ?? null };
  }

  /** 討論中問不到模型：記一則錯誤，停下來 */
  private async discussionError(sessionId: string, e: unknown): Promise<'error'> {
    await this.deps.repo.addMessage(sessionId, { role: 'error', content: t('沒有得到回答：{p0}', { p0: describeError(e) }), detail: errorDetail(e) });
    if (this.state.session?.id === sessionId) this.deps.onEvent?.('failed');
    return 'error';
  }

  /** 某個 Agent 正式發言：串流到畫面；講完回 true，停止或出錯回 false */
  private async speak(sessionId: string, a: Agent, replyTo: string | null, run: Run, opts: { expand?: boolean; altGroup?: string } = {}): Promise<boolean> {
    const { repo } = this.deps;
    const s = await repo.getSession(sessionId);
    const m = s ? this.modelFor(a, s) : null;
    if (!s || !m) return false;
    const here = () => this.state.session?.id === sessionId;
    const signal = run.abort.signal;
    const contextTokens = await this.runtimeContext(m.url, m.model);
    const build = async () => {
      const cur = (await repo.getSession(sessionId))!;
      const members = await repo.listMembers(sessionId);
      const names = new Map(members.map((x) => [x.agent.id, x.agent.name]));
      const msgs = await repo.listMessages(sessionId);
      for (const id of msgs.flatMap((x) => (x.agentId && !names.has(x.agentId) ? [x.agentId] : []))) names.set(id, (await repo.getAgent(id))?.name ?? 'AI');
      // 你最後附的照片：看得懂圖的模型才送
      const lastUser = [...msgs].reverse().find((x) => x.role === 'user');
      const images = lastUser?.attachments.length && m.info?.vision !== false ? { id: lastUser.id, data: lastUser.attachments.map((x) => x.base64) } : undefined;
      return {
        out: speakMessages({
          me: this.toSpeaker(a),
          members: members.map((x) => this.toSpeaker(x)),
          role: await this.roleFor(a),
          notes: (await repo.listNotes(a.id, 5)).map((n) => n.content),
          summary: cur.summary,
          summarySeq: cur.summarySeq,
          lines: toLines(msgs, names),
          replyTo: replyTo ?? '',
          expand: opts.expand,
          contextTokens,
          images,
        }),
      };
    };
    let { out } = await build();
    // 前面的對話放不下：先併進前情摘要
    if (out.overflowSeq !== null) {
      try {
        await this.summarize(sessionId, out.overflowSeq, m.url, m.model, m.info, run, contextTokens);
      } catch (e) {
        if (signal.aborted) return false;
      }
      ({ out } = await build());
    }
    this.setPhase(sessionId, run, { phase: 'speaking', agentId: a.id });
    const placeholder = await repo.addMessage(sessionId, {
      role: 'assistant',
      content: '',
      model: m.model,
      hostLabel: this.hostLabel(m.url),
      agentId: a.id,
      replyTo,
      altGroup: opts.altGroup ?? null,
      detail: out.truncatedRole ? ROLE_TRUNCATED : '',
    });
    run.streaming = { messageId: placeholder.id, content: '', thinking: '', startedAt: this.now(), phase: 'waiting', agentId: a.id };
    if (here()) {
      this.set({ messages: await repo.listMessages(sessionId) });
      if (!this.state.agents[a.id]) await this.refreshGroup();
    }
    this.publishRuns();
    let content = '';
    let thinking = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!run.streaming) return;
      run.streaming = { ...run.streaming, content: cleanReply(content, a.name), thinking, phase: content ? 'answering' : thinking ? 'thinking' : 'waiting' };
      if (here()) this.set({ streaming: run.streaming });
    };
    try {
      const sentThink = thinkToSend(m.info, s.think);
      const mayLeak = !!m.info?.think && !sentThink;
      let raw = '';
      const result = await this.clientFor(m.url).chat(
        { model: m.model, messages: out.messages, think: sentThink },
        (d) => {
          if (d.thinking) thinking += d.thinking;
          if (d.content) {
            raw += d.content;
            const split = mayLeak ? splitThink(raw) : null;
            content = split ? split.content : raw;
            if (split) thinking = split.thinking;
          }
          if (!timer) timer = setTimeout(flush, this.throttleMs);
        },
        signal
      );
      const stats = { evalCount: result.evalCount, evalDurationNs: result.evalDurationNs, promptEvalCount: result.promptEvalCount, totalDurationNs: result.totalDurationNs };
      await repo.updateMessage(placeholder.id, { content: cleanReply(content, a.name).trim(), thinking, stats });
      return true;
    } catch (e) {
      await this.notePairingLost(m.url, e);
      const cancelled = e instanceof OllamaError && e.kind === 'cancelled';
      if (content.trim() || thinking) await repo.updateMessage(placeholder.id, { content: cleanReply(content, a.name).trim(), thinking });
      else await repo.deleteMessage(placeholder.id);
      if (cancelled) {
        await repo.addMessage(sessionId, { role: 'note', content: t('已停止') });
        if (here()) this.deps.onEvent?.('stopped');
      } else {
        await this.discussionError(sessionId, e);
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      run.streaming = null;
      this.publishRuns();
      if (here()) this.set({ messages: await repo.listMessages(sessionId) });
      void this.refreshLoaded(m.url);
    }
  }

  /** 把第 upTo 則（含）以前、還沒摘要過的對話併進前情摘要（太多就分幾次） */
  private async summarize(sessionId: string, upTo: number, url: string, model: string, info: ModelInfo | undefined, run: Run, contextTokens: number): Promise<void> {
    const { repo } = this.deps;
    this.setPhase(sessionId, run, { phase: 'summarizing', agentId: null });
    for (;;) {
      const s = await repo.getSession(sessionId);
      if (!s || s.summarySeq >= upTo) return;
      const names = new Map((await repo.listMembers(sessionId)).map((x) => [x.agent.id, x.agent.name]));
      const pending = toLines(await repo.listMessages(sessionId), names).filter((l) => l.seq > s.summarySeq && l.seq <= upTo);
      if (pending.length === 0) return void (await repo.updateSession(sessionId, { summarySeq: upTo }));
      // 一次只塞得下上下文的一半
      const chunk: Line[] = [];
      let room = Math.floor(contextTokens * 0.5) - estimateTokens(s.summary);
      for (const l of pending) {
        room -= estimateTokens(l.content) + 8;
        if (room < 0 && chunk.length > 0) break;
        chunk.push(l);
      }
      const text = await this.collect(url, model, summaryMessages(s.summary, chunk), { think: quickThink(info), options: { num_predict: 700 }, signal: run.abort.signal });
      const summary = (info?.think ? (splitThink(text)?.content ?? text) : text).trim();
      await repo.updateSession(sessionId, { summary: summary || s.summary, summarySeq: chunk.at(-1)!.seq });
    }
  }

  // ---- 手機上動手做事 ----

  private timeZone(): string {
    try {
      return this.deps.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    } catch {
      return 'UTC';
    }
  }

  /** App 內建、有其他工具時一起給的工具（問使用者選擇題） */
  private readonly builtinTools = [askUserTool()];

  /** 這次可以給模型的工具：模型要會叫工具才給；設定裡關掉的分類不給；有工具時加上「問使用者」 */
  private toolsFor(info: ModelInfo | undefined): PhoneTool[] {
    if (!info?.tools) return [];
    const off = new Set(this.state.prefs.toolsOff ?? []);
    const tools = (this.deps.tools ?? []).filter((tool) => !tool.group || !off.has(tool.group));
    return tools.length > 0 ? [...tools, ...this.builtinTools] : [];
  }

  /** 設定頁「AI 可以做的事」要列出的分類 */
  toolGroups(): ToolGroup[] {
    return [...new Set((this.deps.tools ?? []).map((tool) => tool.group).filter((g): g is ToolGroup => !!g))];
  }

  async setToolGroup(group: ToolGroup, on: boolean): Promise<void> {
    const off = new Set(this.state.prefs.toolsOff ?? []);
    if (on) off.delete(group);
    else off.add(group);
    await this.setPref('toolsOff', [...off]);
  }

  /** 做過的事（設定頁的清單） */
  listDoneActions() {
    return this.deps.repo.listDoneActions();
  }

  /** 照名稱找工具（畫面顯示確認卡也用） */
  toolFor(name: string): PhoneTool | undefined {
    return [...(this.deps.tools ?? []), ...this.builtinTools].find((tool) => tool.name === name);
  }

  /** 加一則工具結果（content 交給模型，detail 是給使用者看的一句話） */
  private async addToolResult(sessionId: string, call: ToolCall, result: Parameters<typeof toolResultContent>[0], summary: string): Promise<void> {
    await this.deps.repo.addMessage(sessionId, { role: 'tool', content: toolResultContent(result), detail: summary, toolName: call.name, toolCallId: call.id });
  }

  /**
   * 處理 AI 這次叫的工具：先檢查名稱與輸入，只讀的直接做，會改東西的變成確認卡。
   * 回傳 continue（全部做完，接著問模型）或 wait（有確認卡在等使用者）。
   */
  private async runToolCalls(sessionId: string, messageId: string, calls: ToolCall[]): Promise<'continue' | 'wait'> {
    const { repo } = this.deps;
    const ctx = { now: this.now() };
    const results: { call: ToolCall; run: Promise<Parameters<typeof toolResultContent>[0] & { summary: string }> }[] = [];
    let waiting = 0;
    for (const call of calls) {
      const tool = this.toolFor(call.name);
      const reject = (error: string, summary = '') => results.push({ call, run: Promise.resolve({ ok: false as const, error, summary }) });
      if (!tool) {
        reject(`There is no tool named "${call.name}".`);
        continue;
      }
      if (tool.group && this.state.prefs.toolsOff?.includes(tool.group)) {
        reject(toolOffError(tool.name, tool.group), t('沒有做：「{p0}」在設定裡關掉了', { p0: toolGroupName(tool.group) }));
        continue;
      }
      const parsed = parseArguments(call.arguments);
      const checked = parsed.ok ? validateInput(tool.inputSchema, parsed.value) : parsed;
      if (!checked.ok) {
        reject(`Invalid arguments for ${tool.name}: ${checked.error} Fix them and call the tool again.`);
        continue;
      }
      const problem = tool.check?.(checked.value, ctx);
      if (problem) {
        reject(problem);
        continue;
      }
      if (!needsConfirmation(tool)) {
        results.push({
          call,
          run: tool.run(checked.value).then(
            (out) => ({ ok: true as const, result: out.data, summary: out.summary }),
            (e) =>
              e instanceof ToolPermissionError
                ? { ok: false as const, error: `permission_denied: ${e.forModel}`, summary: e.message }
                : { ok: false as const, error: errorDetail(e), summary: t('沒有做成：{p0}', { p0: tool.label }) }
          ),
        });
        continue;
      }
      const filled = (await tool.fillDefaults?.(checked.value, ctx)) ?? { input: checked.value, guessed: [] };
      await repo.addAction({ sessionId, messageId, callId: call.id, tool: tool.name, input: filled.input, guessed: filled.guessed, status: 'pending' });
      waiting++;
    }
    // 結果照叫的順序放進對話
    for (const { call, run } of results) {
      const { summary, ...result } = await run;
      await this.addToolResult(sessionId, call, result, summary);
    }
    if (this.state.session?.id === sessionId) this.set({ messages: await repo.listMessages(sessionId) });
    return waiting > 0 ? 'wait' : 'continue';
  }

  /** 從最後一則使用者訊息之後，AI 已經叫了幾輪工具 */
  private toolRounds(msgs: Message[]): number {
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    return msgs.slice(lastUser + 1).filter((m) => m.role === 'assistant' && m.toolCalls?.length).length;
  }

  /** 工具都有結果了：交回模型接著回答（那段在背景也一樣）；叫太多輪就停下來 */
  private async continueAfterTools(sessionId = this.state.session?.id): Promise<void> {
    const { repo } = this.deps;
    if (!sessionId || this.runs.has(sessionId)) return;
    const msgs = await repo.listMessages(sessionId);
    if (msgs.some((m) => m.actions?.some((a) => a.status === 'pending'))) return;
    if (this.toolRounds(msgs) >= MAX_TOOL_ROUNDS) {
      await repo.addMessage(sessionId, { role: 'note', content: t('做到一半停下來了：AI 叫了太多次工具。已經做的事在上面，可以復原。') });
      const after = await repo.listMessages(sessionId);
      if (this.state.session?.id === sessionId) this.set({ messages: after });
      return;
    }
    await this.answer({ sessionId });
  }

  private actionBusy = new Set<string>();

  /** 使用者按了確認卡上的動詞按鈕（edited：按「修改」改過的內容） */
  async approveAction(id: string, edited?: ToolInput): Promise<void> {
    const action = await this.deps.repo.getAction(id);
    if (!action || action.status !== 'pending' || this.actionBusy.has(id)) return;
    const input = this.editedInput(action, edited);
    await this.runAction(action, input);
    await this.afterAction(action.sessionId);
  }

  /**
   * 清單卡：一次確認好幾件事。items 是勾著的（可能改過內容），skip 是取消勾選的。
   * 先檢查全部改過的內容，有錯就一件都不做；做的時候顯示做到第幾件。
   */
  async approveActions(items: { id: string; edited?: ToolInput }[], skip: string[] = []): Promise<void> {
    const { repo } = this.deps;
    const actions = (await Promise.all(items.map((x) => repo.getAction(x.id)))).filter((a): a is Action => !!a && a.status === 'pending');
    const inputs = actions.map((a) => this.editedInput(a, items.find((x) => x.id === a.id)?.edited));
    const sessionId = actions[0]?.sessionId ?? (await repo.getAction(skip[0] ?? ''))?.sessionId;
    if (!sessionId) return;
    for (const id of skip) {
      const a = await repo.getAction(id);
      if (a?.status !== 'pending') continue;
      await repo.updateAction(id, { status: 'declined' });
      await this.addToolResult(a.sessionId, { id: a.callId, name: a.tool, arguments: a.input }, { ok: false, error: 'The user unchecked this item, so it was not done.', ...this.itemOf(a) }, '');
    }
    try {
      for (const [i, a] of actions.entries()) {
        this.set({ acting: { messageId: a.messageId, done: i, total: actions.length } });
        await this.runAction(a, inputs[i]);
      }
    } finally {
      this.set({ acting: null });
    }
    await this.afterAction(sessionId);
  }

  /** 使用者改過的內容：照格式檢查（不對就丟錯，什麼都不做）；選擇題的回答直接放進去 */
  private editedInput(action: Action, edited?: ToolInput): ToolInput {
    if (!edited) return action.input;
    // 改成空字串的欄位是使用者拿掉了，不是沿用 AI 原本的值
    const merged: ToolInput = { ...action.input };
    for (const [key, value] of Object.entries(edited)) {
      if (value === '') delete merged[key];
      else merged[key] = value;
    }
    const tool = this.toolFor(action.tool);
    if (!tool || tool.kind === 'question') return merged;
    const checked = validateInput(tool.inputSchema, merged);
    if (!checked.ok) throw new Error(t('改過的內容格式不對，請再檢查一次。'));
    return checked.value;
  }

  /** 真的去做一件確認過的事，結果記下來並交給模型（不接著問模型，讓呼叫的人決定） */
  private async runAction(action: Action, input: ToolInput): Promise<void> {
    const { repo } = this.deps;
    const id = action.id;
    const tool = this.toolFor(action.tool);
    if (this.actionBusy.has(id)) return;
    this.actionBusy.add(id);
    try {
      const call: ToolCall = { id: action.callId, name: action.tool, arguments: action.input };
      const changes = tool?.kind === 'question' ? '' : describeChanges(action.input, input);
      if (!tool) {
        await repo.updateAction(id, { status: 'failed', note: t('這個 App 版本沒有這個功能。') });
        await this.addToolResult(action.sessionId, call, { ok: false, error: `The tool "${action.tool}" is not available.` }, '');
        return;
      }
      try {
        const out = await tool.run(input);
        await repo.updateAction(id, { status: 'done', input, result: out.data, summary: out.summary, ...(changes ? { note: changes } : {}) });
        await this.addToolResult(action.sessionId, call, { ok: true, result: out.data, ...(changes ? { note: `The user changed these fields before confirming: ${changes}` } : {}) }, '');
        if (tool.kind !== 'question') this.deps.onEvent?.('acted');
      } catch (e) {
        const denied = e instanceof ToolPermissionError;
        await repo.updateAction(id, { status: 'failed', input, note: describeError(e), ...(denied ? { result: { error: 'permission_denied' } } : {}) });
        await this.addToolResult(action.sessionId, call, { ok: false, error: denied ? `permission_denied: ${e.forModel}` : errorDetail(e), ...this.itemOf(action, input) }, '');
      }
    } finally {
      this.actionBusy.delete(id);
    }
  }

  /**
   * 送給模型時最後補的提醒：這段對話裡按過「復原」的；
   * 剛按完確認卡（最後一則是工具結果）時，再加那一輪按「不要」、取消勾選、改過才做的
   */
  private lastRoundNote(messages: Message[]): string {
    const name = (a: Action) => this.itemOf(a).item ?? this.toolFor(a.tool)?.label ?? a.tool;
    const undone = messages.flatMap((m) => m.actions ?? []).filter((a) => a.status === 'undone').map(name);
    const notes = [undone.length > 0 ? undonePrompt(undone) : ''];
    // 「你按了復原」的紀錄行不算：例如回答失敗、按了復原、再按「重新回答」時，最後一則其實還是工具結果
    const real = messages.filter((m) => !isRecordNote(m));
    if (real[real.length - 1]?.role === 'tool') {
      const round = [...real].reverse().find((m) => m.role === 'assistant' && m.toolCalls?.length);
      const actions = round?.actions ?? [];
      // 選擇題按「不回答」也記成 declined，但不是「沒做」：另外一句
      const isQuestion = (a: Action) => this.toolFor(a.tool)?.kind === 'question';
      const declined = actions.filter((a) => a.status === 'declined' && !isQuestion(a)).map(name);
      const unanswered = actions.filter((a) => a.status === 'declined' && isQuestion(a)).map((a) => String(a.input.question ?? ''));
      const edited = actions.filter((a) => a.status === 'done' && a.note).map((a) => ({ item: name(a), changes: a.note }));
      notes.push(declined.length > 0 ? declinedPrompt(declined) : '', unanswered.length > 0 ? unansweredPrompt(unanswered) : '', edited.length > 0 ? editedPrompt(edited) : '');
    }
    return notes.filter(Boolean).join('\n');
  }

  /** 沒做成的是哪一件（交給模型：只有順序的話，有些模型會把沒做的說成做了） */
  private itemOf(action: Action, input = action.input): { item?: string } {
    try {
      const text = this.toolFor(action.tool)?.describe?.(input);
      return text ? { item: text } : {};
    } catch {
      return {};
    }
  }

  /** 使用者按了「不要」（reason：想改成怎樣，可以不填） */
  async declineAction(id: string, reason = ''): Promise<void> {
    await this.declineActions([id], reason);
  }

  /** 一次拒絕好幾件（清單卡的「全部不要」），全部記好才接著問模型 */
  async declineActions(ids: string[], reason = ''): Promise<void> {
    const { repo } = this.deps;
    let sessionId = '';
    for (const id of ids) {
      const action = await repo.getAction(id);
      if (!action || action.status !== 'pending' || this.actionBusy.has(id)) continue;
      sessionId = action.sessionId;
      await repo.updateAction(id, { status: 'declined', note: reason.trim() });
      await this.addToolResult(
        action.sessionId,
        { id: action.callId, name: action.tool, arguments: action.input },
        { ok: false, error: 'The user declined this action.', ...(reason.trim() ? { reason: reason.trim() } : {}), ...this.itemOf(action) },
        ''
      );
    }
    if (sessionId) await this.afterAction(sessionId);
  }

  /** 確認卡都處理完了就接著問模型 */
  private async afterAction(sessionId: string): Promise<void> {
    if (this.state.session?.id === sessionId) this.set({ messages: await this.deps.repo.listMessages(sessionId) });
    await this.continueAfterTools(sessionId);
  }

  /** 復原做過的動作（例如刪掉剛加的行程） */
  async undoAction(id: string): Promise<void> {
    const { repo } = this.deps;
    const action = await repo.getAction(id);
    const tool = action && this.toolFor(action.tool);
    if (!action || action.status !== 'done' || !tool?.undo) return;
    await tool.undo(action.result);
    await repo.updateAction(id, { status: 'undone' });
    // 照時間順序在最下面記一行：上面 AI 說「已經加好了」的那件，後來被你復原了
    await repo.addMessage(action.sessionId, { role: 'note', content: t('你按了復原：{p0}', { p0: action.summary || (tool.label ?? action.tool) }), detail: RECORD_NOTE });
    if (this.state.session?.id === action.sessionId) this.set({ messages: await repo.listMessages(action.sessionId) });
  }

  /** 使用者沒按確認卡就說了別的：還在等的動作都當作不要 */
  private async declinePending(sessionId: string): Promise<void> {
    const pending = this.state.messages.flatMap((m) => m.actions ?? []).filter((a: Action) => a.status === 'pending');
    for (const a of pending) {
      await this.deps.repo.updateAction(a.id, { status: 'skipped' });
      await this.addToolResult(sessionId, { id: a.callId, name: a.tool, arguments: a.input }, { ok: false, error: 'The user did not confirm and sent a new message instead.', ...this.itemOf(a) }, '');
    }
  }

  /** 請模型取標題；失敗就用第一句話的開頭。使用者這段時間自己改了標題就不蓋掉 */
  private async autoTitle(sessionId: string, url: string, model: string, info: ModelInfo | undefined): Promise<void> {
    const { repo } = this.deps;
    const msgs = await repo.listMessages(sessionId);
    const first = msgs.findIndex((m) => m.role === 'user');
    const question = msgs[first]?.content ?? '';
    // 第一輪叫了工具（出了卡片）：之後 AI 的話是看你按了什麼才說的（「沒有加」「改成 11/27」），
    // 拿來取標題會變成「新增失敗」「日期錯誤」這種誤導的標題，只用你的第一句話
    const usedTools = !!msgs.slice(first + 1).find((m) => m.role === 'assistant')?.toolCalls?.length;
    const answer = usedTools ? '' : (msgs.find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '');
    let title = '';
    try {
      let text = '';
      const think = !info?.think ? undefined : info.think.kind === 'always' ? true : info.think.kind === 'toggle' ? false : info.think.levels[0];
      await this.clientFor(url).chat(
        {
          model,
          think,
          messages: [
            { role: 'system', content: TITLE_PROMPTS[this.appLanguage()] },
            { role: 'user', content: answer ? t('使用者：{p0}\nAI：{p1}', { p0: question.slice(0, 300), p1: answer.slice(0, 500) }) : t('使用者：{p0}', { p0: question.slice(0, 300) }) },
          ],
        },
        (d) => (text += d.content ?? '')
      );
      // 一定會思考的模型：只拿思考之後的部分
      title = cleanTitle(info?.think ? (splitThink(text)?.content ?? text) : text);
    } catch {
      // 取不到就用備案
    }
    if (!title) title = fallbackTitle(question);
    const current = await repo.getSession(sessionId);
    if (!current || current.title) return;
    await repo.updateSession(sessionId, { title });
    if (this.state.session?.id === sessionId) this.set({ session: { ...this.state.session, title } });
  }

  /** 刪除所有對話：全部移到最近刪除（可以復原），保留電腦與模型設定；換成一段新的空白對話 */
  async deleteAllSessions(): Promise<void> {
    const { repo } = this.deps;
    this.stopAll();
    await this.dismissUndo();
    const ids = await repo.trashAllSessions();
    this.set({ session: await this.createSessionFromLast(), messages: [], context: null, notice: '', threads: {} });
    await this.offerUndo(t('已刪除 {p0} 段對話', { p0: ids.length }), async () => {
      await repo.restoreSessions(ids);
      await repo.deleteEmptySessions();
      await this.openLatestOrNew();
    });
  }

  /**
   * 清除全部資料（對話、電腦、設定），回到第一次打開的樣子。
   * 畫面上那幾秒內可以復原；時間到才真的刪掉並壓縮檔案（中途關掉 App，下次打開時刪）。
   */
  async resetAll(): Promise<void> {
    const { repo } = this.deps;
    this.stopAll();
    this.stopScan();
    const snapshot = await repo.snapshotSettings();
    // 本來就在最近刪除的也一起清掉；按「復原」只救回這次移過去的
    const before = (await repo.listTrash()).map((s) => s.id);
    const ids = await repo.trashAllSessions();
    const wipe = [...before, ...ids];
    await repo.clearSettings();
    await repo.setSetting(SETTING_PENDING_WIPE, JSON.stringify(wipe));
    const saved = { hosts: this.state.hosts, hostStatus: this.state.hostStatus, models: this.state.models, loaded: this.state.loaded };
    this.set({
      hosts: [],
      hostStatus: {},
      scan: null,
      models: {},
      loaded: {},
      helperInfo: {},
      downloads: {},
      session: await repo.createSession(),
      messages: [],
      context: null,
      notice: '',
    });
    await this.offerUndo(
      t('已清除全部資料'),
      async () => {
        await repo.restoreSnapshot(snapshot);
        await repo.restoreSessions(ids);
        await repo.deleteEmptySessions();
        this.set({ ...saved });
        await this.openLatestOrNew();
      },
      async () => {
        // 這幾秒內從「最近刪除」救回的對話留著（之前會被整張表一起刪掉）
        await repo.wipe(wipe);
        for (const h of saved.hosts) if (h.helperId) await this.forgetToken(h.helperId);
        if (!this.state.session || !(await repo.getSession(this.state.session.id))) {
          this.set({ session: (await repo.listSessions())[0] ?? (await repo.createSession()), messages: [] });
        }
      }
    );
  }

  /**
   * 從備份還原：用備份檔的內容取代手機上全部的資料。還原前先存一份目前的資料，幾秒內可以「復原」。
   * 不是這個 App 的備份會丟 NotBackupError，目前的資料不會被動到。
   */
  async restoreFromBackup(source: Db): Promise<void> {
    const { repo } = this.deps;
    this.stopAll();
    this.stopScan();
    await this.dismissUndo();
    const snapshot = this.deps.openMemoryDb ? await this.deps.openMemoryDb() : null;
    if (snapshot) await repo.copyTo(snapshot);
    await repo.replaceWith(source);
    await this.reloadAll();
    if (snapshot) {
      await this.offerUndo(t('已從備份還原'), async () => {
        await repo.replaceWith(snapshot);
        await this.reloadAll();
      });
    }
  }

  /** 資料整個換掉之後（還原、復原）重新讀一次 */
  private async reloadAll(): Promise<void> {
    const { repo } = this.deps;
    await repo.migrate();
    const latest = (await repo.listSessions())[0];
    const session = latest ?? (await this.createSessionFromLast());
    const hosts = await repo.listHosts();
    await this.loadTokens(hosts);
    try {
      this.alwaysThink = new Set(JSON.parse((await repo.getSetting(SETTING_ALWAYS_THINK)) ?? '[]'));
    } catch {
      this.alwaysThink = new Set();
    }
    this.set({
      hosts,
      hostStatus: {},
      scan: null,
      models: {},
      loaded: {},
      session,
      messages: await repo.listMessages(session.id),
      prefs: await this.loadPrefs(),
      context: null,
      notice: '',
    });
    setLanguage(this.appLanguage());
    this.set({});
    void this.refreshHosts();
    if (session.hostUrl) void this.loadModels(session.hostUrl);
  }

  /** 資料存在哪裡、多大、有幾段對話 */
  async dataInfo(): Promise<{ path: string | null; bytes: number; sessions: number; trash: number }> {
    const { repo } = this.deps;
    return { path: repo.dbPath(), bytes: await repo.sizeBytes(), sessions: await repo.countSessions(), trash: await repo.countTrash() };
  }

  /** 準備匯出整個資料庫：先合併暫存的寫入，回傳可以分享的檔案網址；沒有檔案（記憶體資料庫）回 null */
  async prepareDatabaseExport(): Promise<string | null> {
    const { repo } = this.deps;
    const path = repo.dbPath();
    if (!path) return null;
    await repo.checkpoint();
    return path.startsWith('file://') ? path : `file://${path}`;
  }

  /** 模型實際執行時的上下文上限：優先看已載入模型的設定，查不到才用模型本身的最大值 */
  private async contextLimit(url: string, model: string): Promise<number | null> {
    try {
      const loaded = await this.clientFor(url).loaded();
      this.set({ loaded: { ...this.state.loaded, [url]: loaded } });
      const hit = loaded.find((m) => m.name === model);
      if (hit?.contextLength) return hit.contextLength;
    } catch {
      // 查不到就用模型資訊
    }
    return this.state.models[url]?.list.find((m) => m.name === model)?.contextLength ?? null;
  }
}
