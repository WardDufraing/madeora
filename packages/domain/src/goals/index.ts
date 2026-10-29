/**
 * Goals (S30; spec "Confirmed measurable and completion-based goals", "Confirmed collaborative Home
 * goal contributions", "Confirmed completed goal lifecycle and guided renewal", "Confirmed
 * configurable goal deadline and overdue reminders"). Pure and framework-free. The database
 * (`private.goal_limit`, `private.valid_goal_quantity`, `private.valid_goal_shape`,
 * `private.goal_status` in supabase/migrations/*_goals.sql) decides every case again; these helpers
 * let forms and pages explain a refusal or a state before asking.
 *
 * Quantities share the habit unit catalogue and its exact decimals (../habits/numeric.ts): in the
 * browser they are whole numbers of thousandths, so sums never meet binary floating point.
 */
import {
  habitUnitInfo,
  parseQuantity,
  type HabitUnit,
  type ParsedQuantity,
} from "../habits/numeric";

export const GOAL_LIMITS = {
  title: 80,
  description: 500,
  note: 280,
  reason: 200,
  /** Goals per context that are not archived. */
  goals: 100,
  query: 80,
  /** Largest target, contribution, initial value or total, in units. */
  max: 1_000_000_000,
  /** An advance reminder at most this many days before the deadline. */
  leadDays: 90,
  /** An overdue reminder at most this many days after the day after it. */
  overdueDays: 30,
} as const;

/** Thousandths per unit. */
const SCALE = 1000;

export const goalKinds = ["completion", "measurable"] as const;
export type GoalKind = (typeof goalKinds)[number];

export const goalViews = ["active", "completed", "archived"] as const;
export type GoalView = (typeof goalViews)[number];

/** As `private.goal_status` answers it. */
export const goalStatuses = ["active", "overdue", "achieved", "archived"] as const;
export type GoalStatus = (typeof goalStatuses)[number];

export const goalEntryKinds = ["initial", "contribution", "adjustment"] as const;
export type GoalEntryKind = (typeof goalEntryKinds)[number];

export const goalReminderKinds = ["lead", "overdue"] as const;
export type GoalReminderKind = (typeof goalReminderKinds)[number];

/**
 * Reads an amount typed in the person's locale for a goal: a target or a contribution (strictly
 * positive) or, with `zero`, an initial value or a total. Whole numbers only for a discrete unit.
 */
export function parseGoalQuantity(
  text: string,
  locale: string,
  unit: HabitUnit,
  options: { readonly zero?: boolean } = {},
): ParsedQuantity {
  return parseQuantity(text, locale, unit, { max: GOAL_LIMITS.max, zero: options.zero === true });
}

/** A goal's status on `today` (a local `YYYY-MM-DD`), as `private.goal_status` decides it. */
export function goalStatus(
  goal: {
    readonly archivedAt: string | null;
    readonly achievedAt: string | null;
    readonly deadline: string | null;
  },
  today: string,
): GoalStatus {
  if (goal.archivedAt !== null) return "archived";
  if (goal.achievedAt !== null) return "achieved";
  if (goal.deadline !== null && goal.deadline < today) return "overdue";
  return "active";
}

export interface GoalProgress {
  /** The total in thousandths, uncapped. */
  readonly total: number;
  readonly target: number;
  /** Whole percentage, uncapped (125 for 125 of 100); 0 for a zero target. */
  readonly percent: number;
  /** For a progress bar: 0 to 1. */
  readonly fraction: number;
  readonly reached: boolean;
  /** How far above the target, in thousandths (0 below it). */
  readonly overTarget: number;
}

/** Progress of a measurable goal from thousandths, exact; never caps the recorded numbers. */
export function goalProgress(total: number, target: number): GoalProgress {
  const percent = target <= 0 ? 0 : Math.floor((total * 100) / target);
  return {
    total,
    target,
    percent,
    fraction: target <= 0 ? 0 : Math.max(0, Math.min(1, total / target)),
    reached: target > 0 && total >= target,
    overTarget: Math.max(0, total - target),
  };
}

/** The same rule as `private.valid_goal_quantity` on thousandths. */
export function isValidGoalThousandths(
  value: number,
  unit: HabitUnit,
  options: { readonly zero?: boolean } = {},
): boolean {
  if (!Number.isSafeInteger(value) || value > GOAL_LIMITS.max * SCALE) return false;
  if (value < 0 || (value === 0 && options.zero !== true)) return false;
  const info = habitUnitInfo(unit);
  return info !== null && (!info.discrete || value % SCALE === 0);
}

/** Whether reminder settings are in range (a deadline is checked by the database). */
export function isValidGoalReminder(settings: {
  readonly leadDays: number | null;
  readonly overdueDays: number | null;
  readonly atTime: string;
}): boolean {
  const { leadDays, overdueDays, atTime } = settings;
  if (leadDays === null && overdueDays === null) return false;
  if (
    leadDays !== null &&
    (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > GOAL_LIMITS.leadDays)
  )
    return false;
  if (
    overdueDays !== null &&
    (!Number.isInteger(overdueDays) || overdueDays < 0 || overdueDays > GOAL_LIMITS.overdueDays)
  )
    return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(atTime);
}
