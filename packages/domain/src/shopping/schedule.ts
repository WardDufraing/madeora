/**
 * Recurring shopping item schedules (S26; spec "Confirmed recurring shopping items"). Pure and
 * framework-free: the same rules as `private.shopping_due_on_or_after`, used for the schedule
 * preview. Dates are calendar dates ("2027-03-31") in the context's timezone, so a daylight-saving
 * change never adds or skips an occurrence. Monthly on a day the month lacks: its last day.
 */

export const shoppingFrequencies = ["daily", "weekly", "monthly"] as const;
export type ShoppingFrequency = (typeof shoppingFrequencies)[number];

/** ISO weekdays: 1 Monday … 7 Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface ShoppingSchedule {
  readonly frequency: ShoppingFrequency;
  /** Weekly only: at least one. */
  readonly weekdays: readonly IsoWeekday[] | null;
  /** Monthly only: 1–31. */
  readonly monthDay: number | null;
  /** The first day it may be due (null: from now). */
  readonly startOn: string | null;
}

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtc(date: string): Date {
  const match = isoDate.exec(date);
  if (!match) throw new RangeError(`Not a date: ${date}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = toUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return fromUtc(value);
}

/** Whether a schedule is well formed (the database's check). */
export function isValidSchedule(schedule: ShoppingSchedule): boolean {
  switch (schedule.frequency) {
    case "daily":
      return schedule.weekdays === null && schedule.monthDay === null;
    case "weekly":
      return (
        schedule.monthDay === null &&
        schedule.weekdays !== null &&
        schedule.weekdays.length >= 1 &&
        new Set(schedule.weekdays).size === schedule.weekdays.length &&
        schedule.weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
      );
    case "monthly":
      return (
        schedule.weekdays === null &&
        schedule.monthDay !== null &&
        Number.isInteger(schedule.monthDay) &&
        schedule.monthDay >= 1 &&
        schedule.monthDay <= 31
      );
  }
}

/** The first due day on or after `from` (never before the start date). */
export function dueOnOrAfter(schedule: ShoppingSchedule, from: string): string {
  const start = schedule.startOn !== null && schedule.startOn > from ? schedule.startOn : from;
  if (schedule.frequency === "daily") return start;
  if (schedule.frequency === "weekly") {
    const days = new Set(schedule.weekdays ?? []);
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays(start, offset);
      const weekday = toUtc(day).getUTCDay() || 7;
      if (days.has(weekday as IsoWeekday)) return day;
    }
    throw new RangeError("A weekly schedule needs a weekday");
  }
  const monthDay = schedule.monthDay ?? 1;
  const first = toUtc(start);
  for (let step = 0; step < 2; step += 1) {
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth() + step;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = fromUtc(new Date(Date.UTC(year, month, Math.min(monthDay, last))));
    if (day >= start) return day;
  }
  throw new RangeError("Unreachable");
}

/** The next `count` due days after `today` (the preview: an item made today is not one of them). */
export function nextDueDays(schedule: ShoppingSchedule, today: string, count = 3): string[] {
  const days: string[] = [];
  let from = addDays(today, 1);
  while (days.length < count) {
    const day = dueOnOrAfter(schedule, from);
    days.push(day);
    from = addDays(day, 1);
  }
  return days;
}
