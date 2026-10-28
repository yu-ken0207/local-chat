import { hostUrl, parseHostInput, scanHosts, subnetCandidates } from '../lib/discovery';
import { contextLevel, type ContextLevel } from '../lib/format';
import { cleanTitle, exportMarkdown, fallbackTitle } from '../lib/exportMd';
import { DEFAULT_IMAGE_QUESTION, REPLY_PROMPTS, buildChatMessages } from '../lib/history';
import { pickDefaultModel } from '../lib/modelPick';
import { OllamaError, type LoadedModel, type ModelInfo, type OllamaClient, type ThinkSetting } from '../lib/ollama';
import type { Db } from '../store/db';
import type { Attachment, Host, Message, Repo, Session, Template } from '../store/repo';

// 聊天的所有狀態與動作都在這裡；畫面只負責顯示與呼叫。這樣不用手機也能完整測試。

export type HostStatus = { state: 'checking' | 'online' | 'offline'; latencyMs: number | null; version: string };

export type ModelsEntry = { list: ModelInfo[]; loading: boolean; error: string };

export type Streaming = {
  messageId: string;
  content: string;
  thinking: string;
  startedAt: number;
  /** waiting：等模型開始回、thinking：正在思考、answering：正在回答 */
  phase: 'waiting' | 'thinking' | 'answering';
};

export type ContextInfo = { used: number; limit: number | null; level: ContextLevel };

export type ScanState = { running: boolean; done: number; total: number; found: number; error: string };

export type ChatState = {
  ready: boolean;
  hosts: Host[];
  hostStatus: Record<string, HostStatus>;
  scan: ScanState | null;
  models: Record<string, ModelsEntry>;
  loaded: Record<string, LoadedModel[]>;
  session: Session | null;
  messages: Message[];
  streaming: Streaming | null;
  context: ContextInfo | null;
  /** 一次性的提示，例如「這個模型看不懂圖片，前面的照片不會送出」 */
  notice: string;
  templates: Template[];
  /** 剛做的刪除或取代，可以按「復原」（畫面顯示幾秒後消失） */
  undo: { id: number; message: string } | null;
  prefs: Prefs;
};

type PendingUndo = { id: number; message: string; undo: () => Promise<void>; commit?: () => Promise<void> };

export type AppLanguage = 'zh-Hant' | 'en';
/** 使用者在設定裡可以改的偏好 */
export type Prefs = {
  /** App 語言：跟著系統，或指定 */
  language: 'system' | AppLanguage;
  /** AI 回答的語言：跟著 App、指定、或不指定（不送語言提示） */
  replyLanguage: 'app' | AppLanguage | 'any';
  /** 第一次回答後自動請模型取標題 */
  autoTitle: boolean;
};

export const DEFAULT_PREFS: Prefs = { language: 'system', replyLanguage: 'app', autoTitle: true };

export type ChatEvent = 'answered' | 'failed' | 'stopped';

export type ChatDeps = {
  repo: Repo;
  client: (url: string) => OllamaClient;
  /** 手機目前的 Wi-Fi 位址；沒連 Wi-Fi 回 null（不掃描） */
  wifiIp: () => Promise<string | null>;
  now?: () => number;
  /** 串流更新畫面的最短間隔（毫秒），太頻繁會讓 Markdown 一直重排 */
  throttleMs?: number;
  /** 開 App 時，在 Wi-Fi 上且沒有在線的主機就自動掃描區網（預設開） */
  autoScan?: boolean;
  /** 手機系統的語言（「跟著系統」時用） */
  deviceLanguage?: () => AppLanguage;
  /** 開一個暫時的記憶體資料庫（從備份還原前，先把目前的資料存一份給「復原」用） */
  openMemoryDb?: () => Promise<Db>;
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
export const TITLE_PROMPT = '幫下面這段對話取一個標題：繁體中文、15 個字以內、只回標題本身，不要引號和標點。';

const SETTING_LAST_HOST = 'lastHost';
const SETTING_PREFS = 'prefs';
/** 「清除全部資料」還沒確定（還在可以復原的那幾秒）就關掉 App 時，下次打開要真的刪掉的對話 */
const SETTING_PENDING_WIPE = 'pendingWipe';
/** 使用者自己按過「自動尋找」（iPhone 的區域網路權限已經問過），之後開 App 才自動找 */
const SETTING_SCAN_CONSENTED = 'scanConsented';
const SETTING_LAST_MODEL = 'lastModel';
const PROBE_TIMEOUT_MS = 2500;
const SCAN_TIMEOUT_MS = 800;
const WIFI_TIMEOUT_MS = 3000;

/** 錯誤翻成一般人看得懂的一句話（技術細節另外用 errorDetail 取） */
export function describeError(e: unknown): string {
  if (e instanceof OllamaError) {
    if (e.kind === 'network') return '連不到你的電腦。';
    if (e.kind === 'timeout') return '電腦太久沒有回應。';
    if (e.kind === 'cancelled') return '已取消。';
    if (e.kind === 'http' && /not found/i.test(e.message)) return '電腦上找不到這個模型，可能已經被刪除，請換一個模型。';
    if (e.kind === 'http') return '電腦拒絕了這次請求。';
    return `電腦回報錯誤：${e.message}`;
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
  return model.think.kind === 'toggle' ? false : model.think.defaultLevel;
}

export class ChatStore {
  private state: ChatState = {
    ready: false,
    hosts: [],
    hostStatus: {},
    scan: null,
    models: {},
    loaded: {},
    session: null,
    messages: [],
    streaming: null,
    context: null,
    notice: '',
    templates: [],
    undo: null,
    prefs: DEFAULT_PREFS,
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
    this.set({ prefs });
  }

  /** 目前實際的 App 語言 */
  appLanguage(): AppLanguage {
    const pref = this.state.prefs.language;
    return pref === 'system' ? (this.deps.deviceLanguage?.() ?? 'zh-Hant') : pref;
  }

  /** AI 回答要用的語言（null 代表不指定） */
  replyLanguage(): AppLanguage | null {
    const r = this.state.prefs.replyLanguage;
    if (r === 'any') return null;
    return r === 'app' ? this.appLanguage() : r;
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
    await repo.migrate();
    await repo.purgeExpired();
    const pendingWipe = await repo.getSetting(SETTING_PENDING_WIPE);
    if (pendingWipe) {
      for (const id of JSON.parse(pendingWipe) as string[]) await repo.deleteSession(id);
      await repo.clearSettings();
    }
    const hosts = await repo.listHosts();
    const latest = (await repo.listSessions())[0];
    const session = latest ?? (await this.createSessionFromLast());
    this.set({
      hosts,
      session,
      messages: await repo.listMessages(session.id),
      templates: await repo.listTemplates(),
      prefs: await this.loadPrefs(),
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
    const { repo, client } = this.deps;
    const hosts = this.state.hosts;
    this.set({
      hostStatus: Object.fromEntries(hosts.map((h) => [h.url, { state: 'checking', latencyMs: null, version: h.version } as HostStatus])),
    });
    await Promise.all(
      hosts.map(async (h) => {
        let status: HostStatus;
        try {
          const v = await client(h.url).version(PROBE_TIMEOUT_MS);
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
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('等了 3 秒沒有回應')), WIFI_TIMEOUT_MS))),
      ]);
    } catch (e) {
      clearTimeout(timer);
      this.set({ scan: { running: false, done: 0, total: 0, found: 0, error: `沒辦法確認手機的網路（${errorDetail(e)}）。請改用「手動輸入位址」。` } });
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
            ? '這個 Wi-Fi 沒辦法自動尋找。請改用「手動輸入位址」。'
            : '手機目前沒有連 Wi-Fi，沒辦法自動尋找。請連上跟電腦同一個 Wi-Fi，或改用「手動輸入位址」。',
        },
      });
      return 0;
    }
    this.scanAbort = new AbortController();
    this.set({ scan: { running: true, done: 0, total: candidates.length, found: 0, error: '' } });
    const found = await scanHosts(
      candidates.map((c) => hostUrl(c)),
      async (url) => (await client(url).version(SCAN_TIMEOUT_MS)).version,
      {
        signal: this.scanAbort.signal,
        onProgress: (done) => this.set({ scan: { ...this.state.scan!, done } }),
        onFound: () => this.set({ scan: { ...this.state.scan!, found: this.state.scan!.found + 1 } }),
      }
    );
    for (const f of found) {
      await repo.saveHost({ url: f.url, label: f.url.replace(/^http:\/\//, '').replace(/:11434$/, ''), source: 'scan', version: f.version });
    }
    const hostStatus = { ...this.state.hostStatus };
    for (const f of found) hostStatus[f.url] = { state: 'online', latencyMs: null, version: f.version };
    this.set({ hosts: await repo.listHosts(), hostStatus, scan: { ...this.state.scan!, running: false } });
    this.scanAbort = null;
    if (found.length > 0 && !this.state.session?.model) await this.connectHost(found[0].url);
    return found.length;
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
    const label = options.label?.trim() || parsed.label;
    let version = '';
    let status: HostStatus = { state: 'offline', latencyMs: null, version: '' };
    try {
      const v = await client(parsed.url).version(PROBE_TIMEOUT_MS);
      version = v.version;
      status = { state: 'online', latencyMs: v.latencyMs, version };
    } catch (e) {
      if (!options.force) throw new HostOfflineError(parsed.url, label, '連不到這個位址。');
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

  async renameHost(url: string, label: string): Promise<void> {
    await this.deps.repo.renameHost(url, label.trim() || this.hostLabel(url));
    this.set({ hosts: await this.deps.repo.listHosts() });
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
    await this.offerUndo(`已移除「${host.label}」`, async () => {
      await repo.restoreHost(host);
      this.set({
        hosts: await repo.listHosts(),
        hostStatus: status ? { ...this.state.hostStatus, [url]: status } : this.state.hostStatus,
        models: modelsEntry ? { ...this.state.models, [url]: modelsEntry } : this.state.models,
      });
    });
  }

  // ---- 模型 ----

  /** 抓主機的模型清單與已載入的模型 */
  async loadModels(url: string): Promise<void> {
    const c = this.deps.client(url);
    this.set({ models: { ...this.state.models, [url]: { list: this.state.models[url]?.list ?? [], loading: true, error: '' } } });
    try {
      const [list, loaded] = await Promise.all([c.listModels(), c.loaded().catch(() => [] as LoadedModel[])]);
      this.set({
        models: { ...this.state.models, [url]: { list, loading: false, error: '' } },
        loaded: { ...this.state.loaded, [url]: loaded },
      });
      // 對話記得的模型如果原本沒有思考設定，補上預設值
      const s = this.state.session;
      if (s && s.hostUrl === url && s.model && s.think === null) {
        const info = list.find((m) => m.name === s.model);
        if (info?.think) await this.setThink(defaultThink(info));
      }
    } catch (e) {
      this.set({ models: { ...this.state.models, [url]: { list: [], loading: false, error: describeError(e) } } });
    }
  }

  async refreshLoaded(url: string): Promise<void> {
    try {
      const loaded = await this.deps.client(url).loaded();
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
    await this.deps.client(url).preload(model);
    await this.refreshLoaded(url);
  }

  async unload(url: string, model: string): Promise<void> {
    await this.deps.client(url).unload(model);
    await this.refreshLoaded(url);
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
      systemPrompt: '',
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
    await this.offerUndo(`已刪除「${session?.title || '對話'}」`, async () => {
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

  async setSystemPrompt(text: string): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    await this.deps.repo.updateSession(s.id, { systemPrompt: text });
    this.set({ session: { ...s, systemPrompt: text } });
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
    if (!s.hostUrl || !s.model) throw new Error('請先選一個模型');
    if (images.length > 0 && !this.canAttachImages()) throw new Error('這個模型看不懂圖片，不能附照片');
    const content = text.trim() || (images.length > 0 ? DEFAULT_IMAGE_QUESTION : '');
    if (!content) return;
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
      await this.offerUndo(`已刪掉後面的 ${later.length} 則訊息`, async () => {
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
    if (images.length > 0 && !this.canAttachImages()) throw new Error('這個模型看不懂圖片，不能附照片');
    if (!text.trim() && images.length === 0) return;
    const before = new Set((await repo.listMessages(s.id)).map((m) => m.id));
    const old = await repo.softDeleteFrom(s.id, target.seq);
    this.set({ messages: await repo.listMessages(s.id) });
    await this.offerUndo('已取代原本的訊息', async () => {
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
    await this.offerUndo('已刪除訊息', async () => {
      await repo.restoreMessages([id]);
      if (this.state.session?.id === s.id) this.set({ messages: await repo.listMessages(s.id) });
    });
  }

  // ---- 提示詞範本 ----

  async addTemplate(title: string, content: string): Promise<void> {
    await this.deps.repo.addTemplate(title.trim(), content);
    this.set({ templates: await this.deps.repo.listTemplates() });
  }

  async updateTemplate(id: string, title: string, content: string): Promise<void> {
    await this.deps.repo.updateTemplate(id, title.trim(), content);
    this.set({ templates: await this.deps.repo.listTemplates() });
  }

  /** 刪除範本（可以復原） */
  async deleteTemplate(id: string): Promise<void> {
    const { repo } = this.deps;
    const tpl = this.state.templates.find((x) => x.id === id);
    if (!tpl) return;
    await repo.deleteTemplate(id);
    this.set({ templates: await repo.listTemplates() });
    await this.offerUndo(`已刪除範本「${tpl.title}」`, async () => {
      await repo.restoreTemplate(tpl);
      this.set({ templates: await repo.listTemplates() });
    });
  }

  /** 中途停止回答 */
  stop(): void {
    this.abort?.abort();
  }

  /** 依目前對話內容向模型要一則新的回答（send、重新產生、編輯重送共用） */
  private async answer(options: { altGroup?: string } = {}): Promise<void> {
    const { repo, client } = this.deps;
    const s = this.state.session!;
    const url = s.hostUrl!;
    const model = s.model!;
    const info = this.currentModel();
    const reply = this.replyLanguage();
    const { messages: history, droppedImages } = buildChatMessages(this.state.messages, {
      systemPrompt: s.systemPrompt,
      vision: info ? info.vision : true,
      defaultSystemPrompt: reply ? REPLY_PROMPTS[reply] : '',
    });
    if (droppedImages > 0) this.set({ notice: `目前的模型看不懂圖片，前面的 ${droppedImages} 張照片這次不會送出。` });

    const hostLabel = this.hostLabel(url);
    const placeholder = await repo.addMessage(s.id, { role: 'assistant', content: '', model, hostLabel, altGroup: options.altGroup ?? null });
    const streaming: Streaming = { messageId: placeholder.id, content: '', thinking: '', startedAt: this.now(), phase: 'waiting' };
    this.set({ streaming, messages: [...this.state.messages, placeholder] });

    // 串流的字先累積，固定間隔才更新畫面
    let content = '';
    let thinking = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!this.state.streaming) return;
      this.set({
        streaming: { ...this.state.streaming, content, thinking, phase: content ? 'answering' : thinking ? 'thinking' : 'waiting' },
      });
    };

    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      const result = await client(url).chat(
        { model, messages: history, think: info?.think ? (s.think ?? defaultThink(info) ?? undefined) : undefined },
        (d) => {
          if (d.thinking) thinking += d.thinking;
          if (d.content) content += d.content;
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
      await repo.updateMessage(placeholder.id, { content, thinking, stats });
      const limit = await this.contextLimit(url, model);
      const used = result.promptEvalCount + result.evalCount;
      this.set({ context: { used, limit, level: contextLevel(used, limit) } });
      this.deps.onEvent?.('answered');
      // 第一個回答出來後，請模型幫這段對話取標題（不擋住下一次輸入）
      const answered = (await repo.listMessages(s.id)).filter((m) => m.role === 'assistant' && m.content.trim()).length;
      if (this.state.prefs.autoTitle && !this.state.session?.title && answered === 1) this.titleTask = this.autoTitle(s.id, url, model, info);
    } catch (e) {
      const cancelled = e instanceof OllamaError && e.kind === 'cancelled';
      if (content || thinking) {
        await repo.updateMessage(placeholder.id, { content, thinking });
      } else {
        await repo.deleteMessage(placeholder.id);
      }
      await repo.addMessage(
        s.id,
        cancelled ? { role: 'note', content: '已停止' } : { role: 'error', content: `沒有得到回答：${describeError(e)}`, detail: errorDetail(e) }
      );
      this.deps.onEvent?.(cancelled ? 'stopped' : 'failed');
    } finally {
      if (timer) clearTimeout(timer);
      this.abort = null;
      this.set({ streaming: null, messages: await repo.listMessages(s.id) });
      void this.refreshLoaded(url);
    }
  }

  /** 請模型取標題；失敗就用第一句話的開頭。使用者這段時間自己改了標題就不蓋掉 */
  private async autoTitle(sessionId: string, url: string, model: string, info: ModelInfo | undefined): Promise<void> {
    const { repo, client } = this.deps;
    const msgs = await repo.listMessages(sessionId);
    const question = msgs.find((m) => m.role === 'user')?.content ?? '';
    const answer = msgs.find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
    let title = '';
    try {
      let text = '';
      const think = info?.think ? (info.think.kind === 'toggle' ? false : info.think.levels[0]) : undefined;
      await client(url).chat(
        {
          model,
          think,
          messages: [
            { role: 'system', content: TITLE_PROMPT },
            { role: 'user', content: `使用者：${question.slice(0, 300)}\nAI：${answer.slice(0, 500)}` },
          ],
        },
        (d) => (text += d.content ?? '')
      );
      title = cleanTitle(text);
    } catch {
      // 取不到就用備案
    }
    if (!title) title = fallbackTitle(question);
    const current = await repo.getSession(sessionId);
    if (!current || current.title) return;
    await repo.updateSession(sessionId, { title });
    if (this.state.session?.id === sessionId) this.set({ session: { ...this.state.session, title } });
  }

  /** 把某段對話匯出成 Markdown 文字 */
  async exportSession(id: string): Promise<{ title: string; markdown: string }> {
    const { repo } = this.deps;
    const session = await repo.getSession(id);
    if (!session) throw new Error('找不到這段對話');
    const messages = await repo.listMessages(id);
    return {
      title: session.title || '對話',
      markdown: exportMarkdown(session, messages, { hostLabel: this.hostLabel(session.hostUrl), now: this.now() }),
    };
  }

  /** 刪除所有對話：全部移到最近刪除（可以復原），保留電腦、範本與模型設定；換成一段新的空白對話 */
  async deleteAllSessions(): Promise<void> {
    const { repo } = this.deps;
    this.stop();
    const ids = await repo.trashAllSessions();
    this.set({ session: await this.createSessionFromLast(), messages: [], context: null, notice: '' });
    await this.offerUndo(`已刪除 ${ids.length} 段對話`, async () => {
      await repo.restoreSessions(ids);
      await repo.deleteEmptySessions();
      await this.openLatestOrNew();
    });
  }

  /**
   * 清除全部資料（對話、電腦、範本、設定），回到第一次打開的樣子。
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
      session: await repo.createSession(),
      messages: [],
      context: null,
      notice: '',
      templates: await repo.listTemplates(),
    });
    await this.offerUndo(
      '已清除全部資料',
      async () => {
        await repo.restoreSnapshot(snapshot);
        await repo.restoreSessions(ids);
        await repo.deleteEmptySessions();
        this.set({ ...saved, templates: await repo.listTemplates() });
        await this.openLatestOrNew();
      },
      async () => {
        for (const id of ids) await repo.deleteSession(id);
        await repo.setSetting(SETTING_PENDING_WIPE, '');
        await repo.resetAll();
        this.set({ templates: await repo.listTemplates(), session: (await repo.listSessions())[0] ?? (await repo.createSession()), messages: [] });
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
      await this.offerUndo('已從備份還原', async () => {
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
    this.set({
      hosts: await repo.listHosts(),
      hostStatus: {},
      scan: null,
      models: {},
      loaded: {},
      session,
      messages: await repo.listMessages(session.id),
      templates: await repo.listTemplates(),
      prefs: await this.loadPrefs(),
      context: null,
      notice: '',
    });
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
      const loaded = await this.deps.client(url).loaded();
      this.set({ loaded: { ...this.state.loaded, [url]: loaded } });
      const hit = loaded.find((m) => m.name === model);
      if (hit?.contextLength) return hit.contextLength;
    } catch {
      // 查不到就用模型資訊
    }
    return this.state.models[url]?.list.find((m) => m.name === model)?.contextLength ?? null;
  }
}
