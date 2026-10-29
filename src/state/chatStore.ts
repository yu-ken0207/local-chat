import { hostUrl, parseHostInput, scanHosts, subnetCandidates } from '../lib/discovery';
import { HELPER_PORT, pairErrorMessage, parsePairingPayload } from '../lib/helper';
import { contextLevel, type ContextLevel } from '../lib/format';
import { cleanTitle, fallbackTitle } from '../lib/title';
import { REPLY_PROMPTS, buildChatMessages, defaultImageQuestion } from '../lib/history';
import { pickDefaultModel } from '../lib/modelPick';
import { OllamaError, splitThink, type DownloadJob, type HelperHello, type HelperInfo, type LoadedModel, type ModelInfo, type OllamaClient, type ThinkSetting } from '../lib/ollama';
import type { Db } from '../store/db';
import { ToolPermissionError, describeChanges, needsConfirmation, parseArguments, toOllamaTools, toolGroupName, toolOffError, toolResultContent, toolSystemPrompt, toolsOffPrompt, validateInput, type PhoneTool, type ToolCall, type ToolGroup, type ToolInput } from '../lib/tools';
import type { Action, Attachment, Host, Message, Repo, Session } from '../store/repo';
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
};

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
};

type PendingUndo = { id: number; message: string; undo: () => Promise<void>; commit?: () => Promise<void> };

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
  };
  private pendingUndo: PendingUndo | null = null;
  private undoCounter = 0;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  /** 正在幫對話取標題（測試用來等它完成） */
  titleTask: Promise<void> | null = null;
  /** 開 App 時的檢查主機＋自動掃描（測試用來等它完成） */
  startupTask: Promise<void> | null = null;
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

  constructor(private readonly deps: ChatDeps) {
    this.now = deps.now ?? Date.now;
    this.throttleMs = deps.throttleMs ?? 50;
  }

  // ---- 訂閱 ----

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
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
    if (latest) this.set({ session: latest, messages: await repo.listMessages(latest.id), context: null, notice: '' });
    else this.set({ session: await this.createSessionFromLast(), messages: [], context: null, notice: '' });
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
    if (pendingWipe) {
      for (const id of JSON.parse(pendingWipe) as string[]) await repo.deleteSession(id);
      await repo.clearSettings();
    }
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
    this.deps.onEvent?.('answered');
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
    this.stop();
    const s = this.state.session;
    if (s && this.state.messages.length === 0) return;
    const next = await repo.createSession({
      hostUrl: s?.hostUrl ?? null,
      model: s?.model ?? null,
      think: s?.think ?? null,
    });
    await repo.deleteEmptySessions(next.id);
    this.set({ session: next, messages: [], context: null, notice: '' });
  }

  async openSession(id: string): Promise<void> {
    const { repo } = this.deps;
    this.stop();
    const session = await repo.getSession(id);
    if (!session) return;
    const current = this.state.session;
    this.set({ session, messages: await repo.listMessages(id), context: null, notice: '' });
    if (current && current.id !== id) await repo.deleteEmptySessions(id);
    if (session.hostUrl && !this.state.models[session.hostUrl]) void this.loadModels(session.hostUrl);
  }

  /** 刪除對話：移到最近刪除（30 天內可以救回來），畫面上也可以馬上復原 */
  async deleteSession(id: string): Promise<void> {
    const { repo } = this.deps;
    const wasCurrent = this.state.session?.id === id;
    if (wasCurrent) this.stop();
    const session = await repo.getSession(id);
    await repo.trashSessions([id]);
    if (wasCurrent) await this.openLatestOrNew();
    await this.offerUndo(t('已刪除「{p0}」', { p0: session?.title || t('對話') }), async () => {
      await repo.restoreSessions([id]);
      await this.openSession(id);
    });
  }

  /** 最近刪除的對話 */
  listTrash() {
    return this.deps.repo.listTrash();
  }

  /** 從最近刪除救回來 */
  async restoreSession(id: string): Promise<void> {
    await this.deps.repo.restoreSessions([id]);
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

  /** 送出一則訊息並開始串流回答。照片只有模型看得懂圖時才能附 */
  async send(text: string, images: Omit<Attachment, 'id'>[] = []): Promise<void> {
    const s = this.state.session;
    if (!s || this.state.streaming) return;
    if (!s.hostUrl || !s.model) throw new Error(t('請先選一個模型'));
    if (images.length > 0 && !this.canAttachImages()) throw new Error(t('這個模型看不懂圖片，不能附照片'));
    const content = text.trim() || (images.length > 0 ? defaultImageQuestion() : '');
    if (!content) return;
    await this.declinePending(s.id);
    await this.deps.repo.addMessage(s.id, { role: 'user', content, attachments: images });
    this.set({ messages: await this.deps.repo.listMessages(s.id), notice: '' });
    await this.answer();
  }

  /**
   * 重新產生某則回答：刪掉這則回答與之後的訊息，再問一次。
   * 有給 hostUrl／model 時先換成那個模型（換模型重新產生）。
   */
  async regenerate(assistantId: string, override?: { hostUrl: string; model: string }): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const target = this.state.messages.find((m) => m.id === assistantId && m.role === 'assistant');
    if (!s || !target || this.state.streaming) return;
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
    const target = this.state.messages.find((m) => m.id === userId && m.role === 'user');
    if (!s || !target || this.state.streaming) return;
    if (images.length > 0 && !this.canAttachImages()) throw new Error(t('這個模型看不懂圖片，不能附照片'));
    if (!text.trim() && images.length === 0) return;
    const before = new Set((await repo.listMessages(s.id)).map((m) => m.id));
    const old = await repo.softDeleteFrom(s.id, target.seq);
    this.set({ messages: await repo.listMessages(s.id) });
    await this.offerUndo(t('已取代原本的訊息'), async () => {
      this.stop();
      const added = (await repo.listMessages(s.id)).filter((m) => !before.has(m.id));
      for (const m of added) await repo.deleteMessage(m.id);
      await repo.restoreMessages(old);
      if (this.state.session?.id === s.id) this.set({ messages: await repo.listMessages(s.id) });
    });
    await this.send(text, images);
  }

  /** 最後一則是錯誤或「已停止」時，拿掉它（停止的話連半截回答一起拿掉）再問一次 */
  async retry(): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session;
    const msgs = this.state.messages;
    const last = msgs.at(-1);
    if (!s || !last || this.state.streaming || (last.role !== 'error' && last.role !== 'note')) return;
    if (!msgs.some((m) => m.role === 'user')) return;
    await repo.deleteMessage(last.id);
    const before = msgs.at(-2);
    if (last.role === 'note' && before?.role === 'assistant') await repo.deleteMessage(before.id);
    this.set({ messages: await repo.listMessages(s.id), notice: '' });
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
    if (!s || this.state.streaming?.messageId === id) return;
    await repo.softDeleteMessages([id]);
    this.set({ messages: await repo.listMessages(s.id) });
    await this.offerUndo(t('已刪除訊息'), async () => {
      await repo.restoreMessages([id]);
      if (this.state.session?.id === s.id) this.set({ messages: await repo.listMessages(s.id) });
    });
  }

  /** 中途停止回答 */
  stop(): void {
    this.abort?.abort();
  }

  /** 依目前對話內容向模型要一則新的回答（send、重新產生、編輯重送共用） */
  private async answer(options: { altGroup?: string; retried?: boolean } = {}): Promise<void> {
    const { repo } = this.deps;
    const s = this.state.session!;
    const url = s.hostUrl!;
    const model = s.model!;
    const info = this.currentModel();
    const tools = this.toolsFor(info);
    // 設定裡關掉的：模型還是可能照前面的對話去叫，所以先跟它說
    const toolsOff = info?.tools ? this.toolGroups().filter((g) => this.state.prefs.toolsOff?.includes(g)) : [];
    const { messages: history, droppedImages } = buildChatMessages(this.state.messages, {
      vision: info ? info.vision : true,
      systemPrompt:
        REPLY_PROMPTS[this.appLanguage()] +
        (tools.length > 0 ? '\n\n' + toolSystemPrompt(this.now(), this.timeZone()) : '') +
        (toolsOff.length > 0 ? '\n\n' + toolsOffPrompt(toolsOff) : ''),
    });
    if (droppedImages > 0) this.set({ notice: t('目前的模型看不懂圖片，前面的 {p0} 張照片這次不會送出。', { p0: droppedImages }) });

    const hostLabel = this.hostLabel(url);
    const placeholder = await repo.addMessage(s.id, { role: 'assistant', content: '', model, hostLabel, altGroup: options.altGroup ?? null });
    const streaming: Streaming = { messageId: placeholder.id, content: '', thinking: '', startedAt: this.now(), phase: 'waiting' };
    this.set({ streaming, messages: [...this.state.messages, placeholder] });

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
      if (!this.state.streaming) return;
      const allThinking = thinking + leaked;
      this.set({
        streaming: { ...this.state.streaming, content, thinking: allThinking, phase: content ? 'answering' : allThinking ? 'thinking' : 'waiting' },
      });
    };

    this.abort = new AbortController();
    const signal = this.abort.signal;
    // 同時確認連不連得到：根本連不到時馬上停下來找原因，不用等到聊天逾時（最多 3 分鐘）
    let unreachable = false;
    const abortForThis = this.abort;
    const isHelper = !!this.state.hosts.find((h) => h.url === url)?.helperId;
    this.clientFor(url)
      .ping(isHelper, this.deps.probeTimeoutMs ?? 5000)
      .catch((e) => {
        if (e instanceof OllamaError && (e.kind === 'network' || e.kind === 'timeout') && !content && !thinking && this.abort === abortForThis) {
          unreachable = true;
          abortForThis.abort();
        }
      });
    // 模型載入了沒：沒有的話畫面說明第一次比較久
    this.clientFor(url)
      .loaded()
      .then((list) => {
        const st = this.state.streaming;
        if (st?.messageId === placeholder.id) this.set({ streaming: { ...st, loading: !list.some((m) => m.name === model) } });
      })
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
      this.set({ context: { used, limit, level: contextLevel(used, limit) } });
      // AI 要叫工具：只讀的直接做，會改東西的等使用者確認
      if (toolCalls.length > 0) next = await this.runToolCalls(s.id, placeholder.id, toolCalls);
      else this.deps.onEvent?.('answered');
      // 第一個回答出來後，請模型幫這段對話取標題（不擋住下一次輸入）
      const answered = (await repo.listMessages(s.id)).filter((m) => m.role === 'assistant' && m.content.trim()).length;
      if (!this.state.session?.title && answered === 1) this.titleTask = this.autoTitle(s.id, url, model, info);
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
        this.set({ notice: diagnosisText({ kind: 'moved', url: '' }) });
      } else {
        await repo.addMessage(
          s.id,
          cancelled ? { role: 'note', content: t('已停止') } : { role: 'error', content: t('沒有得到回答：{p0}', { p0: reason }), detail: errorDetail(e) }
        );
        this.deps.onEvent?.(cancelled ? 'stopped' : 'failed');
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (this.abort === abortForThis) this.abort = null;
      this.set({ streaming: null, messages: await repo.listMessages(s.id) });
      void this.refreshLoaded(url);
    }
    // 電腦換了位址：已經改好，自動再問一次
    if (retryMoved) await this.answer({ ...options, retried: true });
    // 工具都做完了（不用等使用者）：把結果交回模型，接著回答
    else if (next === 'continue') await this.continueAfterTools();
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
      const filled = tool.fillDefaults?.(checked.value, ctx) ?? { input: checked.value, guessed: [] };
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
  private toolRounds(): number {
    const msgs = this.state.messages;
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    return msgs.slice(lastUser + 1).filter((m) => m.role === 'assistant' && m.toolCalls?.length).length;
  }

  /** 工具都有結果了：交回模型接著回答；叫太多輪就停下來 */
  private async continueAfterTools(): Promise<void> {
    const s = this.state.session;
    if (!s || this.state.streaming) return;
    if (this.state.messages.some((m) => m.actions?.some((a) => a.status === 'pending'))) return;
    if (this.toolRounds() >= MAX_TOOL_ROUNDS) {
      await this.deps.repo.addMessage(s.id, { role: 'note', content: t('做到一半停下來了：AI 叫了太多次工具。已經做的事在上面，可以復原。') });
      this.set({ messages: await this.deps.repo.listMessages(s.id) });
      return;
    }
    await this.answer();
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
    const tool = this.toolFor(action.tool);
    if (!tool || tool.kind === 'question') return { ...action.input, ...edited };
    const checked = validateInput(tool.inputSchema, { ...action.input, ...edited });
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
        await repo.updateAction(id, { status: 'done', input, result: out.data, summary: out.summary });
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
    if (this.state.session?.id !== sessionId) return;
    this.set({ messages: await this.deps.repo.listMessages(sessionId) });
    await this.continueAfterTools();
  }

  /** 復原做過的動作（例如刪掉剛加的行程） */
  async undoAction(id: string): Promise<void> {
    const { repo } = this.deps;
    const action = await repo.getAction(id);
    const tool = action && this.toolFor(action.tool);
    if (!action || action.status !== 'done' || !tool?.undo) return;
    await tool.undo(action.result);
    await repo.updateAction(id, { status: 'undone' });
    if (this.state.session?.id === action.sessionId) this.set({ messages: await repo.listMessages(action.sessionId) });
  }

  /** 使用者沒按確認卡就說了別的：還在等的動作都當作不要 */
  private async declinePending(sessionId: string): Promise<void> {
    const pending = this.state.messages.flatMap((m) => m.actions ?? []).filter((a: Action) => a.status === 'pending');
    for (const a of pending) {
      await this.deps.repo.updateAction(a.id, { status: 'declined' });
      await this.addToolResult(sessionId, { id: a.callId, name: a.tool, arguments: a.input }, { ok: false, error: 'The user did not confirm and sent a new message instead.', ...this.itemOf(a) }, '');
    }
  }

  /** 請模型取標題；失敗就用第一句話的開頭。使用者這段時間自己改了標題就不蓋掉 */
  private async autoTitle(sessionId: string, url: string, model: string, info: ModelInfo | undefined): Promise<void> {
    const { repo } = this.deps;
    const msgs = await repo.listMessages(sessionId);
    const question = msgs.find((m) => m.role === 'user')?.content ?? '';
    const answer = msgs.find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
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
            { role: 'user', content: t('使用者：{p0}\nAI：{p1}', { p0: question.slice(0, 300), p1: answer.slice(0, 500) }) },
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
    this.stop();
    const ids = await repo.trashAllSessions();
    this.set({ session: await this.createSessionFromLast(), messages: [], context: null, notice: '' });
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
    this.stop();
    this.stopScan();
    const snapshot = await repo.snapshotSettings();
    const ids = await repo.trashAllSessions();
    await repo.clearSettings();
    await repo.setSetting(SETTING_PENDING_WIPE, JSON.stringify(ids));
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
        for (const id of ids) await repo.deleteSession(id);
        await repo.setSetting(SETTING_PENDING_WIPE, '');
        await repo.resetAll();
        for (const h of saved.hosts) if (h.helperId) await this.forgetToken(h.helperId);
        this.set({ session: (await repo.listSessions())[0] ?? (await repo.createSession()), messages: [] });
      }
    );
  }

  /**
   * 從備份還原：用備份檔的內容取代手機上全部的資料。還原前先存一份目前的資料，幾秒內可以「復原」。
   * 不是這個 App 的備份會丟 NotBackupError，目前的資料不會被動到。
   */
  async restoreFromBackup(source: Db): Promise<void> {
    const { repo } = this.deps;
    this.stop();
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
