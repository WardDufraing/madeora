/**
 * Habit schedule and calendar helpers (S28; spec "Confirmed flexible habit schedules", "Confirmed
 * forward-only habit schedule changes", "Confirmed habit insights"). Pure and framework-free.
 *
 * Habits use local calendar dates (`YYYY-MM-DD`) in the habit's timezone. The database decides what
 * "today" is and evaluates every date under the schedule version effective on it; these helpers
 * mirror its validation (`private.valid_habit_schedule`, `private.valid_habit_reminder`,
 * `private.habit_earliest_change`) so forms can explain a refusal before sending it.
 */
import { addDays, isoWeekday, weekStartOf } from "../meals/plan";

export { addDays, daysBetween, isMealDate as isHabitDate, isoWeekday } from "../meals/plan";

export const HABIT_LIMITS = {
  name: 80,
  description: 500,
  note: 280,
  reason: 200,
  habits: 100,
  reminderTimes: 3,
  backdateDays: 7,
  query: 80,
  startPastDays: 7,
  startFutureDays: 366,
  undoSeconds: 10,
} as const;

export const habitScheduleKinds = ["daily", "weekdays", "weekly"] as const;
export type HabitScheduleKind = (typeof habitScheduleKinds)[number];

export const habitWeekStarts = ["monday", "saturday", "sunday"] as const;
export type HabitWeekStart = (typeof habitWeekStarts)[number];

export const habitMilestones = [7, 30, 100] as const;
export const habitInsightDays = [7, 30, 90, 365] as const;
export type HabitInsightDays = (typeof habitInsightDays)[number];
export const habitSnoozeMinutes = [15, 30, 60] as const;
export type HabitSnoozeMinutes = (typeof habitSnoozeMinutes)[number];

export const habitViews = ["active", "ended", "archived"] as const;
export type HabitView = (typeof habitViews)[number];

/** The states a date can have on a habit, as `private.habit_day_states` answers them. */
export const habitDayStates = [
  "untracked",
  "not_scheduled",
  "completed",
  "paused",
  "future",
  "open",
  "pending",
  "missed",
] as const;
export type HabitDayState = (typeof habitDayStates)[number];

export const habitStatuses = ["active", "paused", "ended", "upcoming", "archived"] as const;
export type HabitStatus = (typeof habitStatuses)[number];

export interface HabitSchedule {
  readonly kind: HabitScheduleKind;
  readonly weekdays: readonly number[] | null;
  readonly target: number | null;
}

function validWeekdays(weekdays: readonly number[] | null): boolean {
  return (
    weekdays !== null &&
    weekdays.length >= 1 &&
    weekdays.length <= 7 &&
    new Set(weekdays).size === weekdays.length &&
    weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
}

/** Whether a schedule is well formed (`private.valid_habit_schedule`). */
export function isValidHabitSchedule(schedule: HabitSchedule): boolean {
  switch (schedule.kind) {
    case "daily":
      return schedule.weekdays === null && schedule.target === null;
    case "weekdays":
      return schedule.target === null && validWeekdays(schedule.weekdays);
    case "weekly":
      return (
        schedule.weekdays === null &&
        schedule.target !== null &&
        Number.isInteger(schedule.target) &&
        schedule.target >= 1 &&
        schedule.target <= 7
      );
  }
}

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether reminder times (`HH:MM`) and weekdays are well formed (`private.valid_habit_reminder`). */
export function isValidHabitReminder(
  times: readonly string[],
  weekdays: readonly number[],
): boolean {
  return (
    times.length >= 1 &&
    times.length <= HABIT_LIMITS.reminderTimes &&
    new Set(times).size === times.length &&
    times.every((time) => timePattern.test(time)) &&
    validWeekdays(weekdays)
  );
}

/** The first day of the habit week holding `value`. */
export function habitWeekOf(value: string, weekStart: HabitWeekStart): string {
  return weekStartOf(value, weekStart);
}

/**
 * The earliest date a schedule change may take effect: tomorrow, or the next habit week's start when
 * the current or the new version is weekly (`private.habit_earliest_change`). `currentKind` is the
 * version in force tomorrow.
 */
export function earliestHabitChange(
  today: string,
  weekStart: HabitWeekStart,
  currentKind: HabitScheduleKind,
  newKind: HabitScheduleKind,
): string {
  if (currentKind === "weekly" || newKind === "weekly") {
    return addDays(habitWeekOf(today, weekStart), 7);
  }
  return addDays(today, 1);
}

/** The ISO weekdays in display order for a week start (Monday first, or Saturday, or Sunday). */
export function habitWeekdayOrder(weekStart: HabitWeekStart): readonly number[] {
  const first = weekStart === "monday" ? 1 : weekStart === "saturday" ? 6 : 7;
  return Array.from({ length: 7 }, (_, index) => ((first - 1 + index) % 7) + 1);
}

/**
 * The weeks of a month grid (`YYYY-MM`), each seven dates long starting on the week start; dates
 * outside the month are null.
 */
export function habitMonthGrid(
  month: string,
  weekStart: HabitWeekStart,
): readonly (readonly (string | null)[])[] {
  const first = `${month}-01`;
  const weeks: (string | null)[][] = [];
  let cursor = habitWeekOf(first, weekStart);
  while (cursor.slice(0, 7) <= month) {
    const week = Array.from({ length: 7 }, (_, index) => {
      const day = addDays(cursor, index);
      return day.slice(0, 7) === month ? day : null;
    });
    weeks.push(week);
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** Whether `value` falls on one of the chosen ISO weekdays. */
export function onHabitWeekday(value: string, weekdays: readonly number[]): boolean {
  return weekdays.includes(isoWeekday(value));
}
