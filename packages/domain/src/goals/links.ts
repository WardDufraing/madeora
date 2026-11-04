/**
 * Habit-to-goal links (S30c; spec "Confirmed optional numeric habit-to-goal automatic progress
 * synchronization", "Confirmed selectable historical start for habit-to-goal links", "Confirmed
 * multiple independent goal links per numeric habit"). Pure and framework-free. The database
 * (`private.goal_link_convert`, `private.goal_link_limit` and the link functions in
 * supabase/migrations/*_habit_goal_links.sql) decides every case again and computes every preview;
 * these helpers let forms explain a choice before asking.
 */
import { habitUnitInfo, type HabitUnit } from "../habits/numeric";

export const GOAL_LINK_LIMITS = {
  /** Active links into one goal or series. */
  perGoal: 10,
  /** Active links out of one habit. */
  perHabit: 10,
} as const;

/** Where a link starts counting: the habit's today, a chosen past date, or its first start date. */
export const goalLinkStarts = ["today", "date", "beginning"] as const;
export type GoalLinkStart = (typeof goalLinkStarts)[number];

/** What unlinking does with the amount: keep it as a manual adjustment, or take it out. */
export const goalLinkRemovals = ["keep", "remove"] as const;
export type GoalLinkRemoval = (typeof goalLinkRemovals)[number];

/** A link's habit now: usable, archived, in the trash, or purged (the link is then frozen). */
export const goalLinkSources = ["active", "archived", "trash", "deleted"] as const;
export type GoalLinkSource = (typeof goalLinkSources)[number];

/**
 * A habit quantity (thousandths) in a goal's unit, as `private.goal_link_convert` decides it: the
 * same unit or the same custom label as is; another unit of the same dimension by the exact factors,
 * rounded half up to whole thousandths; null when the units are not compatible.
 */
export function linkedThousandths(value: number, from: HabitUnit, to: HabitUnit): number | null {
  if (from.kind === to.kind && from.unit === to.unit) return value;
  if (from.kind !== "preset" || to.kind !== "preset") return null;
  const a = habitUnitInfo(from);
  const b = habitUnitInfo(to);
  if (!a || !b || a.dimension !== b.dimension || a.discrete || b.discrete) return null;
  return Math.round((value * a.factor) / b.factor);
}

/**
 * Whether converting from `from` to `to` can round a day's total (m to km, ml to l, min to h): the
 * goal's unit is not a whole multiple of thousandths of the habit's. False for the same unit.
 */
export function linkConversionRounds(from: HabitUnit, to: HabitUnit): boolean {
  if (from.kind === to.kind && from.unit === to.unit) return false;
  const a = habitUnitInfo(from);
  const b = habitUnitInfo(to);
  if (!a || !b || linkedThousandths(1, from, to) === null) return false;
  return a.factor % b.factor !== 0;
}

/** Whether a habit in `from` may count toward a goal in `to`. */
export function areLinkUnitsCompatible(from: HabitUnit, to: HabitUnit): boolean {
  return linkedThousandths(1, from, to) !== null;
}

/**
 * The first counted day for a start choice (local `YYYY-MM-DD` dates of the habit), or null when the
 * choice is not allowed: a chosen date before the habit's first start date or after today.
 */
export function goalLinkStartDate(
  start: GoalLinkStart,
  facts: { readonly today: string; readonly firstStart: string; readonly date?: string | null },
): string | null {
  if (start === "today") return facts.today;
  if (start === "beginning") return facts.firstStart;
  const date = facts.date ?? null;
  if (date === null || date < facts.firstStart || date > facts.today) return null;
  return date;
}
