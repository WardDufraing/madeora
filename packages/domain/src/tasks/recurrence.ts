/**
 * Recurring task schedules (S19). Pure and framework-free. Dates are calendar dates
 * (`YYYY-MM-DD`) in the context's timezone and never become instants: the arithmetic below works on
 * day numbers only, so a viewer's own timezone or a daylight-saving change cannot move a date.
 *
 * The database decides which occurrences exist (`private.series_first_on_or_after` in
 * supabase/migrations/*_task_recurrence.sql, with the same rules); this module only describes and
 * previews a schedule. `recurrence-vectors.json` holds cases that both must answer alike
 * (tests/db/rls/task-recurrence-vectors.test.ts runs them against the database).
 *
 * Rules (S19 brief default, the owner may change them):
 * - `daily`: every `interval` days from the start date.
 * - `weekly`: on the chosen ISO weekdays (1 Monday … 7 Sunday) of every `interval`-th week, counting
 *   Monday–Sunday weeks from the week of the start date.
 * - `monthly`: on the start date's day of the month, every `interval` months; in a month without
 *   that day (29–31), on its last day.
 * - `yearly`: on the start date's month and day, every `interval` years; 29 February falls back to
 *   28 February in other years.
 * - It ends never, after an end date (inclusive), or after `count` occurrences.
 */

export const recurrenceFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceFrequency = (typeof recurrenceFrequencies)[number];

export const RECURRENCE_LIMITS = { interval: 99, count: 999 } as const;

/** ISO weekday: 1 Monday … 7 Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface RecurrencePattern {
  readonly frequency: RecurrenceFrequency;
  /** 1–99: every `interval` days, weeks, months or years. */
  readonly interval: number;
  /** Weekly only: the weekdays, at least one. Null for the other frequencies. */
  readonly weekdays: readonly IsoWeekday[] | null;
  /** The first possible date (`YYYY-MM-DD`); also the day of month or year for those patterns. */
  readonly startsOn: string;
}

export interface RecurrenceRule extends RecurrencePattern {
  /** The last possible date, inclusive, or null. */
  readonly endsOn: string | null;
  /** At most this many occurrences counted from `startsOn`, or null. */
  readonly count: number | null;
}

const DAY_MS = 86_400_000;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Ymd {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parse(value: string): Ymd {
  const match = datePattern.exec(value);
  if (!match) throw new RangeError(`Not a date: ${value}`);
  const ymd = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (
    ymd.month < 1 ||
    ymd.month > 12 ||
    ymd.day < 1 ||
    ymd.day > monthLength(ymd.year, ymd.month)
  ) {
    throw new RangeError(`Not a date: ${value}`);
  }
  return ymd;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a month (1–12). */
export function monthLength(year: number, month: number): number {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Days since 1970-01-01 (UTC arithmetic only: no timezone is involved). */
function toDay({ year, month, day }: Ymd): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function fromDay(dayNumber: number): string {
  const date = new Date(dayNumber * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** ISO weekday of a day number: 1970-01-01 was a Thursday (4). */
function isoWeekdayOf(dayNumber: number): IsoWeekday {
  return (((((dayNumber + 3) % 7) + 7) % 7) + 1) as IsoWeekday;
}

/** The ISO weekday of a date. */
export function isoWeekday(value: string): IsoWeekday {
  return isoWeekdayOf(toDay(parse(value)));
}

/** A date plus `days` (may be negative). */
export function addDays(value: string, days: number): string {
  return fromDay(toDay(parse(value)) + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return toDay(parse(to)) - toDay(parse(from));
}

function monthDate(year: number, month: number, day: number): number {
  return toDay({ year, month, day: Math.min(day, monthLength(year, month)) });
}

/**
 * The first date of the pattern on or after `from` (never before `startsOn`), ignoring any end.
 * Throws on a malformed pattern; `isValidPattern` says whether one is well formed.
 */
export function firstOnOrAfter(pattern: RecurrencePattern, from: string): string {
  if (!isValidPattern(pattern)) throw new RangeError("Invalid recurrence pattern");
  const start = parse(pattern.startsOn);
  const startDay = toDay(start);
  const target = Math.max(toDay(parse(from)), startDay);
  const n = pattern.interval;
  switch (pattern.frequency) {
    case "daily": {
      const steps = Math.ceil((target - startDay) / n);
      return fromDay(startDay + steps * n);
    }
    case "weekly": {
      const days = [...new Set(pattern.weekdays ?? [])].sort((a, b) => a - b);
      const firstWeek = startDay - (isoWeekdayOf(startDay) - 1);
      let week = Math.floor((target - firstWeek) / 7);
      let from = target;
      // At most two weeks are looked at: the target's (if it is a scheduled week) and the next one.
      for (;;) {
        if (week % n !== 0) {
          week = Math.ceil(week / n) * n;
          from = firstWeek + week * 7;
        }
        const weekStart = firstWeek + week * 7;
        const day = days.find((weekday) => weekStart + weekday - 1 >= from);
        if (day !== undefined) return fromDay(weekStart + day - 1);
        week += n;
        from = firstWeek + week * 7;
      }
    }
    case "monthly": {
      const goal = parse(fromDay(target));
      let index = goal.year * 12 + goal.month - 1 - (start.year * 12 + start.month - 1);
      index = Math.max(0, Math.ceil(index / n) * n);
      for (;;) {
        const months = start.year * 12 + start.month - 1 + index;
        const candidate = monthDate(Math.floor(months / 12), (months % 12) + 1, start.day);
        if (candidate >= target) return fromDay(candidate);
        index += n;
      }
    }
    case "yearly": {
      const goal = parse(fromDay(target));
      let index = Math.max(0, Math.ceil((goal.year - start.year) / n) * n);
      for (;;) {
        const candidate = monthDate(start.year + index, start.month, start.day);
        if (candidate >= target) return fromDay(candidate);
        index += n;
      }
    }
  }
}

/** Whether the pattern is well formed (the database checks the same). */
export function isValidPattern(pattern: RecurrencePattern): boolean {
  if (!recurrenceFrequencies.includes(pattern.frequency)) return false;
  if (!Number.isInteger(pattern.interval)) return false;
  if (pattern.interval < 1 || pattern.interval > RECURRENCE_LIMITS.interval) return false;
  if (!datePattern.test(pattern.startsOn)) return false;
  try {
    parse(pattern.startsOn);
  } catch {
    return false;
  }
  if (pattern.frequency === "weekly") {
    const days = pattern.weekdays ?? [];
    return (
      days.length >= 1 &&
      days.length <= 7 &&
      days.every((day) => day >= 1 && day <= 7) &&
      new Set(days).size === days.length
    );
  }
  return pattern.weekdays === null;
}

/** The last date of a rule that ends after `count` occurrences, or its end date, or null. */
export function lastDate(rule: RecurrenceRule): string | null {
  let end = rule.endsOn;
  if (rule.count !== null) {
    let date = firstOnOrAfter(rule, rule.startsOn);
    for (let index = 1; index < rule.count; index += 1) {
      date = firstOnOrAfter(rule, addDays(date, 1));
    }
    if (end === null || date < end) end = date;
  }
  return end;
}

/**
 * Up to `limit` dates of the rule on or after `from`, in order, within its end. For previews; the
 * database creates the occurrences.
 */
export function upcomingDates(rule: RecurrenceRule, from: string, limit: number): string[] {
  const end = lastDate(rule);
  const dates: string[] = [];
  let next = firstOnOrAfter(rule, from);
  while (dates.length < limit && (end === null || next <= end)) {
    dates.push(next);
    next = firstOnOrAfter(rule, addDays(next, 1));
  }
  return dates;
}
