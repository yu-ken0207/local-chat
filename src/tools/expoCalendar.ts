import * as Calendar from 'expo-calendar/legacy';

import type { CalendarApi } from './calendar';

// 手機上真的碰 iOS 行事曆與提醒事項的部分。SDK 58 的新版 API 在 Expo Go 裡是空殼，所以用 expo-calendar/legacy。

const granted = async (current: () => Promise<{ granted: boolean; canAskAgain: boolean }>, request: () => Promise<{ granted: boolean }>) => {
  const now = await current();
  if (now.granted) return true;
  if (!now.canAskAgain) return false;
  return (await request()).granted;
};

export function expoCalendarApi(): CalendarApi {
  return {
    allowCalendar: () => granted(Calendar.getCalendarPermissionsAsync, Calendar.requestCalendarPermissionsAsync),
    allowReminders: () => granted(Calendar.getRemindersPermissionsAsync, Calendar.requestRemindersPermissionsAsync),
    calendars: async () =>
      (await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)).map((c) => ({ id: c.id, title: c.title, canWrite: c.allowsModifications })),
    defaultCalendarId: async () => {
      try {
        return (await Calendar.getDefaultCalendarAsync()).id;
      } catch {
        return null;
      }
    },
    events: async (calendarIds, start, end) =>
      (await Calendar.getEventsAsync(calendarIds, start, end)).map((e) => ({
        id: e.id,
        title: e.title,
        start: new Date(e.startDate),
        end: new Date(e.endDate),
        allDay: e.allDay,
        calendarId: e.calendarId,
      })),
    createEvent: (calendarId, e) =>
      Calendar.createEventAsync(calendarId, {
        title: e.title,
        startDate: e.start,
        endDate: e.end,
        allDay: e.allDay,
        timeZone: e.timeZone,
        ...(e.location ? { location: e.location } : {}),
        ...(e.notes ? { notes: e.notes } : {}),
        ...(e.alertMinutes !== undefined ? { alarms: [{ relativeOffset: -e.alertMinutes }] } : {}),
      }),
    deleteEvent: (id) => Calendar.deleteEventAsync(id),
    createReminder: (r) =>
      Calendar.createReminderAsync(null, {
        title: r.title,
        ...(r.due ? { dueDate: r.due, startDate: r.due, alarms: [{ absoluteDate: r.due.toISOString() }] } : {}),
        ...(r.notes ? { notes: r.notes } : {}),
      }),
    deleteReminder: (id) => Calendar.deleteReminderAsync(id),
  };
}
