/**
 * Meal-plan calendar helpers (S27; spec "Confirmed configurable meal-planner slots", "Confirmed
 * optional recurring meal-plan entries", "Confirmed whole-week meal-plan copying"). Pure and
 * framework-free.
 *
 * Plans use local calendar dates (`YYYY-MM-DD`) without times or zones: the database decides what
 * "today" is (the Home's timezone, or the app's date for the Personal space) and these helpers only
 * do date arithmetic in UTC, so a daylight-saving change never adds or drops a day.
 */

export const MEAL_LIMITS = {
  slots: 8,
  slotName: 30,
  title: 120,
  notes: 1000,
  maxServings: 99,
  series: 100,
  planDays: 42,
  transferDays: 31,
  horizonDays: 366,
  copyRows: 100,
} as const;

export const mealStandardSlots = ["breakfast", "lunch", "dinner"] as const;
export type MealStandardSlot = (typeof mealStandardSlots)[number];

export const mealCadences = ["daily", "weekdays", "weekly"] as const;
export type MealCadence = (typeof mealCadences)[number];

export const mealWeekStarts = ["monday", "saturday", "sunday"] as const;
export type MealWeekStart = (typeof mealWeekStarts)[number];

/** ISO weekday: 1 Monday … 7 Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a real calendar date written `YYYY-MM-DD` between 2000 and 2100. */
export function isMealDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value >= "2000-01-01" &&
    value <= "2100-12-31"
  );
}

function toDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** `value` plus `days` (negative to go back). */
export function addDays(value: string, days: number): string {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
}

export function isoWeekday(value: string): IsoWeekday {
  const day = toDate(value).getUTCDay();
  return (day === 0 ? 7 : day) as IsoWeekday;
}

const startWeekday: { readonly [W in MealWeekStart]: IsoWeekday } = {
  monday: 1,
  saturday: 6,
  sunday: 7,
};

/** The first day of the week holding `value`, for the person's week-start preference. */
export function weekStartOf(value: string, weekStart: MealWeekStart): string {
  const back = (isoWeekday(value) - startWeekday[weekStart] + 7) % 7;
  return addDays(value, -back);
}

/** The seven dates of the week that starts on `start`. */
export function weekDates(start: string): readonly string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** Whether a repeat schedule is well formed (`private.valid_meal_cadence`). */
export function isValidCadence(cadence: MealCadence, weekdays: readonly number[] | null): boolean {
  if (cadence === "daily") return weekdays === null;
  if (weekdays === null || weekdays.length === 0 || weekdays.length > 7) return false;
  if (new Set(weekdays).size !== weekdays.length) return false;
  if (!weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) return false;
  return cadence === "weekdays" || weekdays.length === 1;
}

/** Whether a schedule has an occurrence on `value` (`private.meal_occurs`, without its dates). */
export function cadenceOccursOn(
  cadence: MealCadence,
  weekdays: readonly number[] | null,
  value: string,
): boolean {
  return cadence === "daily" || (weekdays ?? []).includes(isoWeekday(value));
}

/** A meal or occurrence as the plan read answers it, reduced to where it sits. */
export interface PlacedMeal {
  readonly date: string;
  readonly slotId: string;
}

/** The key of one date and slot. */
export function cellKey(date: string, slotId: string): string {
  return `${date}|${slotId}`;
}

/**
 * The plan's meals grouped by date and slot. A cell with more than one meal is an unresolved
 * conflict the interface must show (never hide one of them).
 */
export function groupByCell<T extends PlacedMeal>(
  meals: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const cells = new Map<string, T[]>();
  for (const meal of meals) {
    const key = cellKey(meal.date, meal.slotId);
    const cell = cells.get(key);
    if (cell) cell.push(meal);
    else cells.set(key, [meal]);
  }
  return cells;
}
