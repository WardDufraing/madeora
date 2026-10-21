import { z } from "zod";

import type { WeekStart } from "@/preferences/schema";

import { calendarQuerySchema, type CalendarQuery, type CalendarView } from "./schema";

/**
 * The task calendar's dates (S19c). Everything here works on calendar dates ("2026-10-20"), never
 * instants: "today" comes from the database in the context's timezone (the Home's, or the person's
 * for Personal), and the grid only counts days, so a DST change cannot move a task to another day.
 */

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const uuid = z.uuid();

export const defaultCalendarQuery: CalendarQuery = calendarQuerySchema.parse({});

/** The calendar's settings from its address; a value it does not understand is dropped. */
export function parseCalendarQuery(params: SearchParams): CalendarQuery {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) raw[key] = value;
  }
  const assignee = raw.assignee;
  if (typeof assignee === "string" && uuid.safeParse(assignee).success) {
    raw.assignee = "member";
    raw.member = assignee;
  }
  const parsed = calendarQuerySchema.safeParse(raw);
  const query = parsed.success
    ? parsed.data
    : (() => {
        const shape = calendarQuerySchema.shape;
        const kept: Record<string, unknown> = {};
        for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
          if (key in raw && shape[key].safeParse(raw[key]).success) kept[key] = raw[key];
        }
        return calendarQuerySchema.safeParse(kept).data ?? defaultCalendarQuery;
      })();
  // A member filter without a member (or the other way round) means anyone.
  if ((query.assignee === "member") !== (query.member !== undefined)) {
    return { ...query, assignee: "any", member: undefined };
  }
  return query;
}

/** Whether a filter differs from the defaults (the list, view and dates are not filters). */
export function hasCalendarFilters(query: CalendarQuery): boolean {
  return (
    query.status !== defaultCalendarQuery.status ||
    query.priority.length > 0 ||
    query.label.length > 0 ||
    query.assignee !== defaultCalendarQuery.assignee
  );
}

/** The calendar's address with some settings changed; defaults are left out. */
export function calendarQueryString(
  query: CalendarQuery,
  changes: Partial<CalendarQuery> = {},
): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams();
  if (next.view !== defaultCalendarQuery.view) params.set("view", next.view);
  if (next.date) params.set("date", next.date);
  if (next.day) params.set("day", next.day);
  if (next.list) params.set("list", next.list);
  if (next.status !== defaultCalendarQuery.status) params.set("status", next.status);
  for (const priority of next.priority) params.append("priority", priority);
  for (const label of next.label) params.append("label", label);
  if (next.assignee === "member" && next.member) params.set("assignee", next.member);
  else if (next.assignee !== "any") params.set("assignee", next.assignee);
  return params.toString();
}

function toUtc(date: string): Date {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = toUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return fromUtc(value);
}

/** Days from `from` to `to` (0 for the same day). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

const weekStartDay: { readonly [W in WeekStart]: number } = { sunday: 0, monday: 1, saturday: 6 };

function startOfWeek(date: string, weekStart: WeekStart): string {
  const day = toUtc(date).getUTCDay();
  return addDays(date, -((day - weekStartDay[weekStart] + 7) % 7));
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(date: string, months: number): string {
  const value = toUtc(firstOfMonth(date));
  value.setUTCMonth(value.getUTCMonth() + months);
  return fromUtc(value);
}

export interface CalendarWindow {
  readonly view: CalendarView;
  /** The date the view is built around: any day of the week, or the first of the month. */
  readonly anchor: string;
  readonly from: string;
  readonly to: string;
  /** Rows of seven dates; in a month view, days outside the month are part of the first/last row. */
  readonly weeks: readonly (readonly string[])[];
  /** The anchor of the previous and next week or month. */
  readonly previous: string;
  readonly next: string;
}

/**
 * The dates a week or month view shows, with the person's first day of the week. A month view is
 * whole weeks from the week of the 1st to the week of the last day: 4 to 6 rows, at most 42 days,
 * the database's limit for one read.
 */
export function calendarWindow(
  view: CalendarView,
  date: string,
  weekStart: WeekStart,
): CalendarWindow {
  if (view === "week") {
    const from = startOfWeek(date, weekStart);
    return {
      view,
      anchor: from,
      from,
      to: addDays(from, 6),
      weeks: [Array.from({ length: 7 }, (_, index) => addDays(from, index))],
      previous: addDays(from, -7),
      next: addDays(from, 7),
    };
  }
  const anchor = firstOfMonth(date);
  const last = addDays(addMonths(anchor, 1), -1);
  const from = startOfWeek(anchor, weekStart);
  const to = addDays(startOfWeek(last, weekStart), 6);
  const days = daysBetween(from, to) + 1;
  const weeks = Array.from({ length: days / 7 }, (_, row) =>
    Array.from({ length: 7 }, (_, column) => addDays(from, row * 7 + column)),
  );
  return {
    view,
    anchor,
    from,
    to,
    weeks,
    previous: addMonths(anchor, -1),
    next: addMonths(anchor, 1),
  };
}

/** Whether `date` belongs to the anchor's month (a month view's other days are dimmed). */
export function inMonth(date: string, anchor: string): boolean {
  return date.slice(0, 7) === anchor.slice(0, 7);
}
