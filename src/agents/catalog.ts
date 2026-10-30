import { getLanguage, t } from '../i18n';
import raw from './catalog.json';

// 圖鑑：App 內建的 Agent（由 scripts/build_catalog.py 從兩個 MIT 授權的集合產生）。
// 索引打包進 App；角色原文很大，分片放在 assets/agents，用到才讀。

export type CategoryKey =
  | 'general'
  | 'code'
  | 'design'
  | 'writing'
  | 'language'
  | 'education'
  | 'academic'
  | 'business'
  | 'marketing'
  | 'life'
  | 'emotions'
  | 'fun';

/** 圖鑑裡的一個 Agent。陣列都是 [繁中, 英文] */
export type CatalogEntry = {
  id: string;
  /** 分類 */
  c: CategoryKey;
  /** emoji（沒有像素頭像時用） */
  e: string;
  /** 名字 */
  n: [string, string];
  /** 一句話介紹 */
  d: [string, string];
  /** 個性一句話（agency 才有） */
  v?: [string, string];
  t: string[];
  /** 作者與網址（授權要求標示） */
  a: string;
  u: string;
  /** 原文在第幾個分片 */
  s: number;
  /** 公開前要再檢查（越獄、髒話） */
  r?: 1;
};

export type CatalogLicense = { name: string; url: string; sha: string; text: string };

const data = raw as unknown as { shards: number; licenses: CatalogLicense[]; entries: CatalogEntry[] };
const byId = new Map(data.entries.map((e) => [e.id, e]));

export const catalogEntries = (): CatalogEntry[] => data.entries;
export const catalogLicenses = (): CatalogLicense[] => data.licenses;
export const getEntry = (id: string): CatalogEntry | undefined => byId.get(id);

const CATEGORY_LABELS: Record<CategoryKey, string> = {
  general: '一般與思考', // i18n-ignore
  code: '程式與工程', // i18n-ignore
  design: '設計', // i18n-ignore
  writing: '寫作與文案', // i18n-ignore
  language: '翻譯與語言', // i18n-ignore
  education: '教育與學習', // i18n-ignore
  academic: '學術研究', // i18n-ignore
  business: '商業與職場', // i18n-ignore
  marketing: '行銷與社群', // i18n-ignore
  life: '生活與健康', // i18n-ignore
  emotions: '情感與心靈', // i18n-ignore
  fun: '娛樂與遊戲', // i18n-ignore
};

/** 分類（照圖鑑篩選列的順序），名稱跟著 App 語言 */
export function categories(): { key: CategoryKey; label: string; count: number }[] {
  const counts = new Map<CategoryKey, number>();
  for (const e of data.entries) counts.set(e.c, (counts.get(e.c) ?? 0) + 1);
  return (Object.keys(CATEGORY_LABELS) as CategoryKey[]).map((key) => ({ key, label: t(CATEGORY_LABELS[key]), count: counts.get(key) ?? 0 }));
}

const langIndex = () => (getLanguage() === 'en' ? 1 : 0);
/** 跟著 App 語言；這個語言沒有就用另一個 */
const pick = (pair: [string, string] | undefined) => (pair ? pair[langIndex()] || pair[1 - langIndex()] : '');
export const entryName = (e: CatalogEntry): string => pick(e.n);
export const entryIntro = (e: CatalogEntry): string => pick(e.d);
export const entryVibe = (e: CatalogEntry): string => pick(e.v);

/**
 * 從圖鑑來、沒改過名字和介紹的 Agent：跟著 App 語言顯示圖鑑的版本（圖鑑改了字也跟著新的）；
 * 圖鑑裡已經沒有這個角色就用存著的。改過沒有記在資料庫（name_custom、intro_custom），不靠字串比對
 */
export function localizeName(catalogId: string | null, name: string): string {
  const e = catalogId ? byId.get(catalogId) : undefined;
  return e ? entryName(e) : name;
}
export function localizeIntro(catalogId: string | null, intro: string): string {
  const e = catalogId ? byId.get(catalogId) : undefined;
  return e ? entryIntro(e) : intro;
}

/** 搜尋圖鑑：每個詞都要出現在名字、介紹、個性或標籤裡（兩種語言都比，不分大小寫）；名字對到的排前面 */
export function searchCatalog(query: string, category?: CategoryKey | null): CatalogEntry[] {
  const list = category ? data.entries.filter((e) => e.c === category) : data.entries;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list;
  const hits: { e: CatalogEntry; name: boolean }[] = [];
  for (const e of list) {
    const name = e.n.join(' ').toLowerCase();
    const all = [name, e.d.join(' '), e.v?.join(' ') ?? '', e.t.join(' ')].join(' ').toLowerCase();
    if (terms.every((w) => all.includes(w))) hits.push({ e, name: terms.every((w) => name.includes(w)) });
  }
  return [...hits.filter((h) => h.name), ...hits.filter((h) => !h.name)].map((h) => h.e);
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
/** 英文名字裡不拿來找頭像的字 */
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'who', 'mr', 'mrs', 'dr']);

/** 圖鑑名字裡有沒有這個詞：英文要整個字對到（Data 不會對到 Dad），中文照字串 */
function inName(name: string, q: string): boolean {
  const a = name.toLowerCase();
  const b = q.toLowerCase();
  if (CJK.test(b)) return a.includes(b);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(a);
}

/**
 * 自己建的 Agent 用哪個圖鑑角色的頭像：先找「名字」對到的，都沒有才用介紹裡提到的（不然「風險管理」會挑到介紹裡剛好有這幾個字的財務專家）。
 * 中文名字：全名、前兩三個字、專長的每一項。英文名字：全名、專長，再用名字裡的單字（整個字對；對到最多字的優先，一樣多時後面的字優先，
 * 英文的主詞通常在後面：Data Detective 是偵探）
 */
export function suggestAvatar(name: string, terms: string[]): string | null {
  const clean = (list: string[]) => [...new Set(list.map((q) => q.trim()).filter((q) => q.length >= 2))];
  const nameHit = (q: string) => searchCatalog(q).find((e) => e.n.some((n) => inName(n, q)))?.id;
  const chars = [...name.trim()];
  const cjk = CJK.test(name);
  const words = cjk ? [] : name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));
  const first = clean(cjk ? [name, chars.slice(0, 2).join(''), chars.slice(0, 3).join(''), ...terms] : [name, ...terms]);
  for (const q of first) {
    const hit = nameHit(q);
    if (hit) return hit;
  }
  let best: { id: string; n: number } | null = null;
  const score = new Map<string, number>();
  for (const w of [...words].reverse()) {
    for (const e of searchCatalog(w)) if (e.n.some((n) => inName(n, w))) score.set(e.id, (score.get(e.id) ?? 0) + 1);
  }
  for (const [id, n] of score) if (!best || n > best.n) best = { id, n };
  if (best) return best.id;
  for (const q of clean([...first, ...words])) {
    const hit = searchCatalog(q)[0];
    if (hit) return hit.id;
  }
  return null;
}

/** 頭像選「用 emoji」時存的值（從圖鑑來的也不會落回圖鑑的像素頭像） */
export const EMOJI_AVATAR = 'emoji';

/** 頭像用的 id：自己挑過的、從圖鑑來的用圖鑑 id（同一個角色同一個頭像、同一個顏色），都沒有用自己的 id；選了 emoji 就用 emoji（底色照樣固定） */
export const avatarId = (a: { id: string; catalogId: string | null; avatar: string | null }) => (a.avatar === EMOJI_AVATAR ? `emoji:${a.id}` : (a.avatar ?? a.catalogId ?? a.id));

/** 一個分片：Agent id 對到各語言的角色原文 */
export type PromptShard = Record<string, { zh?: string; en?: string }>;
export type ShardLoader = (index: number) => Promise<PromptShard>;

/** 角色原文：同一個分片只讀一次 */
export class PromptStore {
  private shards = new Map<number, Promise<PromptShard>>();

  constructor(private readonly load: ShardLoader) {}

  /** 圖鑑某個 Agent 的角色原文（跟著 App 語言，這個語言沒有就用另一個）；找不到是空字串 */
  async get(id: string): Promise<string> {
    const e = byId.get(id);
    if (!e) return '';
    let shard = this.shards.get(e.s);
    if (!shard) {
      shard = this.load(e.s);
      this.shards.set(e.s, shard);
      // 讀失敗不要記住，下次再試
      shard.catch(() => this.shards.delete(e.s));
    }
    const p = (await shard)[id];
    if (!p) return '';
    return (getLanguage() === 'en' ? p.en || p.zh : p.zh || p.en) ?? '';
  }
}
