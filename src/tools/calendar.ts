import { fmtEventTime } from '../lib/format';
import { ToolPermissionError, parseLocal, toLocalText, type PhoneTool, type ToolContext, type ToolInput } from '../lib/tools';
import { getLanguage, t } from '../i18n';

// AI 可以叫的行事曆與提醒事項工具。實際碰 iOS 行事曆的部分在 CalendarApi 後面（手機上是 expoCalendar.ts），
// 測試換成假的。給模型看的說明是英文；畫面上的字經過 t()，用 getter 才會跟著 App 語言變。

export type CalendarInfo = { id: string; title: string; canWrite: boolean };
export type EventInfo = { id: string; title: string; start: Date; end: Date; allDay: boolean; calendarId: string };
export type NewEvent = { title: string; start: Date; end: Date; allDay: boolean; location?: string; notes?: string; alertMinutes?: number; timeZone: string };
export type NewReminder = { title: string; due?: Date; notes?: string };

export type CalendarApi = {
  /** 跟 iOS 要權限（已經給過就直接回 true）；使用者拒絕回 false */
  allowCalendar(): Promise<boolean>;
  allowReminders(): Promise<boolean>;
  calendars(): Promise<CalendarInfo[]>;
  defaultCalendarId(): Promise<string | null>;
  events(calendarIds: string[], start: Date, end: Date): Promise<EventInfo[]>;
  createEvent(calendarId: string, event: NewEvent): Promise<string>;
  deleteEvent(id: string): Promise<void>;
  createReminder(reminder: NewReminder): Promise<string>;
  deleteReminder(id: string): Promise<void>;
};

const DAY = 24 * 60 * 60 * 1000;
/** 一次最多回幾筆行程給模型（本地模型能記的內容有限） */
const MAX_EVENTS = 10;

async function needCalendar(api: CalendarApi): Promise<void> {
  if (!(await api.allowCalendar())) {
    throw new ToolPermissionError(t('沒有行事曆的權限。要讓 AI 看行事曆、加行程，請到「設定」打開。'), 'The user has not allowed calendar access.');
  }
}

async function needReminders(api: CalendarApi): Promise<void> {
  if (!(await api.allowReminders())) {
    throw new ToolPermissionError(t('沒有提醒事項的權限。要讓 AI 加提醒，請到「設定」打開。'), 'The user has not allowed access to Reminders.');
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v));

/** 時間不能在過去，也不能太遠（多半是模型算錯年份）；錯誤訊息交給模型 */
function checkWhen(text: string, ctx: ToolContext, what: string): string | null {
  const when = parseLocal(text).getTime();
  if (when < ctx.now - 10 * 60 * 1000) return `The ${what} is in the past. Check the date with the user.`;
  if (when > ctx.now + 366 * DAY) return `The ${what} is more than a year away. Check the date with the user.`;
  return null;
}

export function calendarTools(api: CalendarApi): PhoneTool[] {
  const findCalendar = async (name: string): Promise<CalendarInfo> => {
    const writable = (await api.calendars()).filter((c) => c.canWrite);
    if (name) {
      const hit = writable.find((c) => c.title.toLowerCase() === name.toLowerCase());
      if (!hit) throw new Error(t('找不到可以加行程的「{p0}」行事曆。', { p0: name }));
      return hit;
    }
    const id = await api.defaultCalendarId();
    const hit = writable.find((c) => c.id === id) ?? writable[0];
    if (!hit) throw new Error(t('手機上沒有可以加行程的行事曆。'));
    return hit;
  };

  const listCalendars: PhoneTool = {
    name: 'list_calendars',
    description: "List the names of the user's calendars that events can be added to.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    get label() {
      return t('看有哪些行事曆');
    },
    group: 'calendar',
    run: async () => {
      await needCalendar(api);
      const names = (await api.calendars()).filter((c) => c.canWrite).map((c) => c.title);
      return { data: names, summary: t('看了有哪些行事曆（{n} 個）', { n: names.length }) };
    },
  };

  const listEvents: PhoneTool = {
    name: 'list_events',
    description: `List events on the user's calendar from start to end (dates, inclusive). Returns at most ${MAX_EVENTS} events.`,
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', format: 'date', description: 'First day, like 2026-11-04' },
        end: { type: 'string', format: 'date', description: 'Last day (inclusive). Leave out for a single day.' },
      },
      required: ['start'],
    },
    annotations: { readOnlyHint: true },
    get label() {
      return t('看行事曆');
    },
    group: 'calendar',
    check: (input) => {
      const start = parseLocal(str(input.start)).getTime();
      const end = input.end ? parseLocal(str(input.end)).getTime() : start;
      if (end < start) return 'end must not be before start.';
      if (end - start > 62 * DAY) return 'Ask for at most two months at a time.';
      return null;
    },
    run: async (input) => {
      await needCalendar(api);
      const calendars = await api.calendars();
      const from = parseLocal(str(input.start));
      const to = new Date(parseLocal(str(input.end || input.start)).getTime() + DAY);
      // 同一個行程同步在好幾個行事曆（例如公司和 iCloud）時只算一筆
      const seen = new Set<string>();
      const all = (await api.events(calendars.map((c) => c.id), from, to))
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .filter((e) => {
          const key = `${e.title}|${e.start.getTime()}|${e.end.getTime()}|${e.allDay}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      const name = (id: string) => calendars.find((c) => c.id === id)?.title ?? '';
      const events = all.slice(0, MAX_EVENTS).map((e) => ({
        title: e.title,
        start: e.allDay ? toLocalText(e.start).slice(0, 10) : toLocalText(e.start),
        end: e.allDay ? undefined : toLocalText(e.end),
        allDay: e.allDay || undefined,
        calendar: name(e.calendarId),
      }));
      return { data: all.length > MAX_EVENTS ? { events, more: all.length - MAX_EVENTS } : { events }, summary: t('看了行事曆（{n} 筆）', { n: all.length }) };
    },
  };

  const createEvent: PhoneTool = {
    name: 'create_event',
    description:
      "Add an event to the user's calendar. The app asks the user to confirm first. Times are local, like 2026-11-04T15:00. Leave out end if the user did not say when it ends. Leave out calendar to use the default one.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string', format: 'date-time' },
        end: { type: 'string', format: 'date-time' },
        allDay: { type: 'boolean' },
        location: { type: 'string' },
        notes: { type: 'string' },
        alertMinutesBefore: { type: 'integer', description: 'Remind the user this many minutes before' },
        calendar: { type: 'string', description: 'Calendar name' },
      },
      required: ['title', 'start'],
    },
    annotations: {},
    get label() {
      return t('加行程');
    },
    get verb() {
      return t('加入');
    },
    group: 'calendar',
    get fields() {
      return { title: t('標題'), start: t('開始'), end: t('結束'), location: t('地點'), calendar: t('行事曆'), alertMinutesBefore: t('提前幾分鐘提醒') };
    },
    fillDefaults: (input) => {
      if (input.allDay || input.end) return { input, guessed: [] };
      return { input: { ...input, end: toLocalText(new Date(parseLocal(str(input.start)).getTime() + 60 * 60 * 1000)) }, guessed: ['end'] };
    },
    check: (input, ctx) => {
      if (input.end && parseLocal(str(input.end)) < parseLocal(str(input.start))) return 'end must be after start.';
      return checkWhen(str(input.start), ctx, 'start time');
    },
    describe: (input) => {
      const when = fmtEventTime(parseLocal(str(input.start)), input.end ? parseLocal(str(input.end)) : null, !!input.allDay, getLanguage());
      const text = input.calendar
        ? t('在 {p0} 新增「{p1}」到「{p2}」行事曆', { p0: when, p1: str(input.title), p2: str(input.calendar) })
        : t('在 {p0} 新增「{p1}」到預設的行事曆', { p0: when, p1: str(input.title) });
      return input.alertMinutesBefore ? text + t('，提前 {n} 分鐘提醒', { n: Number(input.alertMinutesBefore) }) : text;
    },
    run: async (input: ToolInput) => {
      await needCalendar(api);
      const calendar = await findCalendar(str(input.calendar));
      const start = parseLocal(str(input.start));
      const allDay = !!input.allDay;
      const end = input.end ? parseLocal(str(input.end)) : new Date(start.getTime() + (allDay ? DAY : 60 * 60 * 1000));
      const id = await api.createEvent(calendar.id, {
        title: str(input.title),
        start,
        end,
        allDay,
        ...(input.location ? { location: str(input.location) } : {}),
        ...(input.notes ? { notes: str(input.notes) } : {}),
        ...(input.alertMinutesBefore !== undefined ? { alertMinutes: Number(input.alertMinutesBefore) } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      return {
        data: { id, title: str(input.title), start: toLocalText(start), end: toLocalText(end), calendar: calendar.title },
        summary: t('新增行程「{p0}」', { p0: str(input.title) }),
      };
    },
    undo: async (data) => api.deleteEvent(String((data as { id: string }).id)),
  };

  const createReminder: PhoneTool = {
    name: 'create_reminder',
    description:
      "Add a reminder to the user's Reminders app. The app asks the user to confirm first. If the user said when to be reminded, set due as local time like 2026-10-30T09:00.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, due: { type: 'string', format: 'date-time' }, notes: { type: 'string' } },
      required: ['title'],
    },
    annotations: {},
    get label() {
      return t('加提醒');
    },
    get verb() {
      return t('設提醒');
    },
    group: 'reminders',
    get fields() {
      return { title: t('要提醒的事'), due: t('什麼時候提醒') };
    },
    check: (input, ctx) => (input.due ? checkWhen(str(input.due), ctx, 'reminder time') : null),
    describe: (input) =>
      input.due
        ? t('{p0} 提醒你「{p1}」', { p0: fmtEventTime(parseLocal(str(input.due)), null, false, getLanguage()), p1: str(input.title) })
        : t('在「提醒事項」加一項「{p0}」', { p0: str(input.title) }),
    run: async (input) => {
      await needReminders(api);
      const due = input.due ? parseLocal(str(input.due)) : undefined;
      const id = await api.createReminder({ title: str(input.title), ...(due ? { due } : {}), ...(input.notes ? { notes: str(input.notes) } : {}) });
      return { data: { id, title: str(input.title), ...(due ? { due: toLocalText(due) } : {}) }, summary: t('新增提醒「{p0}」', { p0: str(input.title) }) };
    },
    undo: async (data) => api.deleteReminder(String((data as { id: string }).id)),
  };

  return [listCalendars, listEvents, createEvent, createReminder];
}
