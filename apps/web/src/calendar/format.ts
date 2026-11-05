import type { DateTimeFormats } from "@/invitations/format";
import { formatTime } from "@/preferences/regional";
import { addDays, calendarWindow, daysBetween, startOfWeek } from "@/tasks/calendar";
import type { WeekStart } from "@/preferences/schema";

import type { CalendarView } from "./schema";
import type { Occurrence } from "./shapes";

/**
 * Addresses, windows and texts of the calendar (S32). Client-safe. Everything that decides a day
 * works on local dates ("2026-11-04") that the database computed in the shown timezone, so the
 * browser's own timezone never moves an event to another day.
 */

/** The calendar of a context (null: Personal). */
export function calendarPath(homeId: string | null): string {
  return homeId ? `/homes/${homeId}/calendar` : "/calendar";
}

/** One event's page; `on` picks a recurring event's occurrence. */
export function eventPath(homeId: string | null, eventId: string, on?: string | null): string {
  const path = `${calendarPath(homeId)}/events/${eventId}`;
  return on ? `${path}?on=${on}` : path;
}

/** The edit page of an event (or one occurrence of it, `on`). */
export function editEventPath(homeId: string | null, eventId: string, on?: string | null): string {
  const path = `${calendarPath(homeId)}/events/${eventId}/edit`;
  return on ? `${path}?on=${on}` : path;
}

/** The new-event page, optionally starting on `date`. */
export function newEventPath(homeId: string | null, date?: string): string {
  const path = `${calendarPath(homeId)}/new`;
  return date ? `${path}?date=${date}` : path;
}

/** The calendar page's address with a view and a date (defaults left out). */
export function calendarHref(homeId: string | null, view: CalendarView, date?: string): string {
  const params = new URLSearchParams();
  if (view !== "month") params.set("view", view);
  if (date) params.set("date", date);
  const search = params.toString();
  return search ? `${calendarPath(homeId)}?${search}` : calendarPath(homeId);
}

/** TanStack Query keys of calendar reads, so a change drops them all. */
export const calendarKeys = { all: ["calendar"] as const };

/** How many days the agenda shows. */
export const AGENDA_DAYS = 30;

export interface CalendarViewWindow {
  readonly view: CalendarView;
  readonly anchor: string;
  readonly from: string;
  readonly to: string;
  /** Rows of seven dates (month and week); one row of one date (day); the days in order (agenda). */
  readonly weeks: readonly (readonly string[])[];
  readonly previous: string;
  readonly next: string;
}

/**
 * The dates a view covers around `date`, with the person's first day of the week. Every window
 * stays under the database's 62-day limit for one read (a month is at most 42 days).
 */
export function calendarViewWindow(
  view: CalendarView,
  date: string,
  weekStart: WeekStart,
): CalendarViewWindow {
  if (view === "month" || view === "week") return calendarWindow(view, date, weekStart);
  if (view === "day") {
    return {
      view,
      anchor: date,
      from: date,
      to: date,
      weeks: [[date]],
      previous: addDays(date, -1),
      next: addDays(date, 1),
    };
  }
  const to = addDays(date, AGENDA_DAYS - 1);
  return {
    view,
    anchor: date,
    from: date,
    to,
    weeks: [Array.from({ length: AGENDA_DAYS }, (_, index) => addDays(date, index))],
    previous: addDays(date, -AGENDA_DAYS),
    next: addDays(date, AGENDA_DAYS),
  };
}

/** The occurrences on each date of a window (an event over several days is on each of them). */
export function occurrencesByDate(
  occurrences: readonly Occurrence[],
  from: string,
  to: string,
): Map<string, Occurrence[]> {
  const byDate = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const first = occurrence.from > from ? occurrence.from : from;
    const last = occurrence.to < to ? occurrence.to : to;
    const days = daysBetween(first, last);
    for (let index = 0; index <= days; index += 1) {
      const date = addDays(first, index);
      byDate.set(date, [...(byDate.get(date) ?? []), occurrence]);
    }
  }
  return byDate;
}

/** A banner's place in one week row: the first column and how many columns it spans. */
export function bannerSpan(
  week: readonly string[],
  startsOn: string,
  endsOn: string,
): { readonly start: number; readonly span: number } | null {
  const first = week[0];
  const last = week[week.length - 1];
  if (!first || !last || endsOn < first || startsOn > last) return null;
  const start = startsOn > first ? daysBetween(first, startsOn) : 0;
  const end = endsOn < last ? daysBetween(first, endsOn) : week.length - 1;
  return { start, span: end - start + 1 };
}

/** The clock time of an instant in `timeZone`, in the viewer's time format. */
export function clockTime(instant: string, timeZone: string, formats: DateTimeFormats): string {
  return formatTime(new Date(instant), timeZone, formats.timeFormat, formats.locale);
}

/**
 * When an occurrence happens on `date`, in the shown timezone: null for an all-day event (the
 * caller says "All day"), "09:00 – 10:00" for a timed one, with only the start or end on the
 * first or last of several days.
 */
export function occurrenceTimes(
  occurrence: Occurrence,
  date: string,
  timeZone: string,
  formats: DateTimeFormats,
): { readonly start: string | null; readonly end: string | null } | null {
  if (occurrence.allDay || !occurrence.startsAt || !occurrence.endsAt) return null;
  return {
    start: occurrence.from === date ? clockTime(occurrence.startsAt, timeZone, formats) : null,
    end: occurrence.to === date ? clockTime(occurrence.endsAt, timeZone, formats) : null,
  };
}

/** The first day of the week containing `date` (re-exported for the views). */
export { startOfWeek, addDays };
