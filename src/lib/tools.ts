// 手機上動手做事：AI 可以叫的工具（照 MCP 的格式定義），以及叫工具前的檢查與審核。
// 設計見 docs/設計_手機上動手做事.md。工具本身（行事曆、提醒事項）在別的檔案，這裡只管共通的部分。

/** 工具輸入的格式（JSON Schema 的一小部分：一層物件，欄位是字串、數字、整數、是非、字串清單） */
export type FieldSchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: string[];
  /** date-time：YYYY-MM-DDTHH:mm（當地時間）；date：YYYY-MM-DD */
  format?: 'date-time' | 'date';
  /** 清單（type: array）：只支援字串，可以限制幾項 */
  items?: { type: 'string' };
  minItems?: number;
  maxItems?: number;
};
export type InputSchema = { type: 'object'; properties: Record<string, FieldSchema>; required?: string[] };

export type ToolInput = Record<string, string | number | boolean | string[]>;

/** 工具執行完的結果：data 交給模型（要短），summary 給使用者看（例如「新增 1 個行程」） */
export type ToolOutput = { data: unknown; summary: string };

export type ToolContext = { now: number };

export type PhoneTool = {
  /** 給模型看的名稱與說明（英文，模型叫工具的訓練資料大多是英文） */
  name: string;
  description: string;
  inputSchema: InputSchema;
  /** MCP 的屬性標記 */
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  /** 一定要人按（傳送、打電話、刪除這類），沒有「以後不用問」 */
  requiresUserInteraction?: boolean;
  /** 畫面上的白話名稱，例如「加行程」 */
  label: string;
  /** 確認卡按鈕上的動詞，例如「加入」「設提醒」 */
  verb?: string;
  /** 確認卡上各欄位的名稱，例如 { title: '標題' }；沒列的欄位不給改 */
  fields?: Record<string, string>;
  /** 確認卡上的一句白話 */
  describe?(input: ToolInput): string;
  /** 補上使用者沒說的欄位，回傳哪些是補的（確認卡上標淡色） */
  fillDefaults?(input: ToolInput, ctx: ToolContext): { input: ToolInput; guessed: string[] };
  /** 執行前的 App 規則檢查，不通過回原因（英文，交給模型） */
  check?(input: ToolInput, ctx: ToolContext): string | null;
  run(input: ToolInput): Promise<ToolOutput>;
  /** 復原：照執行結果把事情還原 */
  undo?(data: unknown): Promise<void>;
  /** 設定頁「AI 可以做的事」的分類（關掉就不給模型這個工具） */
  group?: ToolGroup;
  /** question：問使用者選擇題（確認卡換成選項按鈕，回答放在 answer） */
  kind?: 'question';
};

export type ToolGroup = 'calendar' | 'reminders';

/** 使用者沒給權限（行事曆、提醒事項）：畫面給「打開設定」，交給模型的是 permission_denied */
export class ToolPermissionError extends Error {
  readonly code = 'permission_denied';
  constructor(
    message: string,
    /** 給模型看的說明（英文） */
    readonly forModel: string
  ) {
    super(message);
    this.name = 'ToolPermissionError';
  }
}

/** 當地時間的文字（2026-11-04T15:00 或 2026-11-04）轉成 Date；只有日期時是那天 00:00 */
export function parseLocal(text: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(text);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

/** Date 轉回當地時間的文字（2026-11-04T15:00） */
export function toLocalText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 模型叫工具（從 Ollama 回來的樣子；arguments 可能是物件，也可能是一串文字） */
export type ToolCall = { id: string; name: string; arguments: unknown };

/** 送給 Ollama 的工具清單 */
export function toOllamaTools(tools: PhoneTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

type Checked = { ok: true; value: ToolInput } | { ok: false; error: string };

/** 模型給的 arguments 轉成物件：可能已經是物件，也可能是 JSON 文字 */
export function parseArguments(raw: unknown): Checked {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return { ok: true, value: {} };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'The arguments are not valid JSON.' };
    }
  }
  if (value === null || value === undefined) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'The arguments must be a JSON object.' };
  return { ok: true, value: value as ToolInput };
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 照格式檢查並整理輸入：數字、是非如果被寫成文字就轉回來；不認得的欄位拿掉；
 * 時間只收當地時間（沒有時區），帶時區的拿掉時區（模型常常亂加 Z）。
 * 錯誤訊息是英文，交回模型重填。
 */
export function validateInput(schema: InputSchema, input: ToolInput): Checked {
  const out: ToolInput = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    let v: unknown = input[key];
    if (v === undefined || v === null || v === '') continue;
    if ((field.type === 'number' || field.type === 'integer') && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) v = Number(v);
    if (field.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
    if (field.type === 'string' && typeof v === 'number') v = String(v);
    if (field.type === 'array') {
      if (typeof v === 'string') {
        const raw: string = v;
        try {
          v = JSON.parse(raw);
        } catch {
          v = raw.split(/[,\n]/);
        }
      }
      if (!Array.isArray(v)) return { ok: false, error: `"${key}" must be a list of strings.` };
      const list = v.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim() : '')).filter(Boolean);
      if (field.minItems !== undefined && list.length < field.minItems) return { ok: false, error: `"${key}" needs at least ${field.minItems} items.` };
      out[key] = field.maxItems !== undefined ? list.slice(0, field.maxItems) : list;
      continue;
    }
    const wrongType =
      field.type === 'string' ? typeof v !== 'string' : field.type === 'boolean' ? typeof v !== 'boolean' : typeof v !== 'number' || !isFinite(v);
    if (wrongType) return { ok: false, error: `"${key}" must be a ${field.type}.` };
    if (field.type === 'integer' && !Number.isInteger(v)) return { ok: false, error: `"${key}" must be a whole number.` };
    if (field.enum && !field.enum.includes(v as string)) return { ok: false, error: `"${key}" must be one of: ${field.enum.join(', ')}.` };
    if (field.format === 'date-time' && typeof v === 'string') {
      v = v.trim().replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
      if (DATE.test(v as string)) v = `${v}T00:00`; // 只給日期（整天的事）：當作那天 00:00
      if (!DATE_TIME.test(v as string) || isNaN(Date.parse(v as string))) return { ok: false, error: `"${key}" must be a local date and time like 2026-11-04T15:00.` };
    }
    if (field.format === 'date' && typeof v === 'string' && (!DATE.test(v) || isNaN(Date.parse(v)))) return { ok: false, error: `"${key}" must be a date like 2026-11-04.` };
    out[key] = v as string | number | boolean;
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined) return { ok: false, error: `"${key}" is required.` };
  }
  return { ok: true, value: out };
}

/** 審核：只讀的直接做；會改東西的（包括一定要人按、會刪東西的）都要使用者確認 */
export function needsConfirmation(tool: PhoneTool): boolean {
  return !tool.annotations.readOnlyHint || !!tool.requiresUserInteraction || !!tool.annotations.destructiveHint;
}

/** 交給模型的工具結果（JSON 文字，太長截掉，本地模型能記的內容有限） */
export function toolResultContent(result: { ok: true; result: unknown; note?: string } | { ok: false; error: string; reason?: string }, max = 2000): string {
  const text = JSON.stringify(result);
  return text.length <= max ? text : text.slice(0, max - 20) + '…(truncated)';
}

/** 使用者改了哪些欄位（交給模型，讓它的回答跟實際一致） */
export function describeChanges(before: ToolInput, after: ToolInput): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
  return keys.map((k) => `${k}: ${JSON.stringify(before[k] ?? null)} -> ${JSON.stringify(after[k] ?? null)}`).join('; ');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLine = (d: Date) => `${ymd(d)} ${WEEKDAYS[d.getDay()].slice(0, 3)}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * 有工具時加在系統提示詞後面的規則（英文，給模型看）：現在時間、日期對照表、什麼時候該叫工具。
 * 小模型很會算錯「這週六」「下週三」，所以直接列出這週和下週每一天的日期讓它查。
 */
export function toolSystemPrompt(now: number, timeZone: string): string {
  const d = new Date(now);
  const local = `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const monday = addDays(d, -((d.getDay() + 6) % 7));
  const week = (offset: number) => Array.from({ length: 7 }, (_, i) => dayLine(addDays(monday, offset + i))).join(', ');
  return [
    `You can use tools to do things on the user's phone. Current local time: ${local} (${WEEKDAYS[d.getDay()]}), time zone ${timeZone}.`,
    'Date lookup (weeks start on Monday; use these dates instead of calculating):',
    `- today: ${dayLine(d)}; tomorrow: ${dayLine(addDays(d, 1))}; day after tomorrow: ${dayLine(addDays(d, 2))}`,
    `- this week: ${week(0)}`,
    `- next week: ${week(7)}`,
    'Rules:',
    '- Use a tool only when the user asks you to do something; otherwise just answer.',
    '- Use only dates and times the user said or that appear in their photos. Never invent missing details; leave optional fields out.',
    '- Optional details (end time, calendar, location, when to remind) are not needed. Do not ask about them; just leave them out.',
    '- Only if something required (what, or which day) is truly unclear, ask the user with ask_user instead of guessing.',
    '- The app asks the user to confirm every change. After a tool result, tell the user in one short sentence what was done.',
  ].join('\n');
}
