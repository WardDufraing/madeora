import { z } from "zod";

import {
  habitDayStates,
  habitScheduleKinds,
  habitStatuses,
  habitUnitKinds,
} from "@madeora/domain/habits";
import { habitAccessLevels, habitMemberAccess } from "@madeora/domain/permissions";

/**
 * The shapes the habit database functions answer (S28; supabase/migrations/*_habits.sql), checked
 * on the server before anything reaches a page, and the types the interface uses. Client-safe.
 * People are membership references (`null`: nobody, a personal habit, or someone who left).
 */

const date = z.iso.date();
const person = z.uuid().nullable();
const weekStart = z.enum(["monday", "saturday", "sunday"]);

export const habitScheduleSchema = z.object({
  effectiveOn: date,
  kind: z.enum(habitScheduleKinds),
  weekdays: z.array(z.int().min(1).max(7)),
  target: z.int().nullable(),
});
export type HabitScheduleVersion = z.infer<typeof habitScheduleSchema>;

export const habitCheckinSchema = z.object({
  id: z.uuid(),
  onDate: date,
  by: person,
  mine: z.boolean(),
  recordedAt: z.string(),
  backdated: z.boolean(),
  source: z.enum(["app", "widget", "notification"]),
  note: z.string().nullable(),
  noteRevision: z.int(),
  noteUpdatedAt: z.string().nullable(),
  status: z.enum(["active", "undone"]),
  undoneBy: person,
  undoneByMe: z.boolean(),
  undoneAt: z.string().nullable(),
  undoKind: z.enum(["undo", "correction"]).nullable(),
  undoReason: z.string().nullable(),
  /** A numeric day's completion, written by the database when the total reaches the target. */
  derived: z.boolean().optional(),
  /** What the viewer may do with it now: their own Undo, a manager's correction, or nothing. */
  action: z.enum(["undo", "correct"]).nullable().optional(),
});
export type HabitCheckin = z.infer<typeof habitCheckinSchema>;

export const habitWeekSchema = z.object({
  weekOn: date,
  firstOn: date,
  lastOn: date,
  endsOn: date.optional(),
  completions: z.int(),
  target: z.int(),
  adjusted: z.int(),
  outcome: z.enum(["done", "missed", "pending", "future", "paused"]),
});
export type HabitWeek = z.infer<typeof habitWeekSchema>;

export const habitBlocks = [
  "archived",
  "future",
  "outside_window",
  "untracked",
  "not_scheduled",
  "already_completed",
  "paused",
  "target_reached",
] as const;
export type HabitBlock = (typeof habitBlocks)[number];

export const contributionBlocks = [...habitBlocks, "not_numeric"] as const;
export type ContributionBlock = (typeof contributionBlocks)[number];

/** How a habit is tracked from a date on: complete once, or a numeric daily target (S29). */
export const habitTrackingSchema = z.object({
  effectiveOn: date.nullable(),
  mode: z.enum(["once", "numeric"]),
  target: z.number().nullable(),
  unit: z.string().nullable(),
  unitKind: z.enum(habitUnitKinds).nullable(),
  quickAdds: z.array(z.number()),
  by: person.optional(),
  at: z.string().nullable().optional(),
});
export type HabitTracking = z.infer<typeof habitTrackingSchema>;

/** One day's numeric progress: the exact total against the target in force that day. */
export const habitProgressSchema = z.object({
  onDate: date,
  total: z.number(),
  target: z.number(),
  unit: z.string(),
  unitKind: z.enum(habitUnitKinds),
  met: z.boolean(),
  above: z.boolean(),
});
export type HabitProgress = z.infer<typeof habitProgressSchema>;

export const habitStreakSchema = z.object({
  current: z.int(),
  unit: z.enum(["occurrences", "weeks"]).nullable(),
  longestOccurrences: z.int(),
  longestWeeks: z.int(),
});
export type HabitStreak = z.infer<typeof habitStreakSchema>;

const pausedBy = z.enum(["manual", "vacation", "both"]).nullable();

export const habitSummarySchema = z.object({
  id: z.uuid(),
  homeId: z.uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  timeZone: z.string(),
  weekStart,
  revision: z.int(),
  status: z.enum(habitStatuses),
  archivedAt: z.string().nullable(),
  today: date,
  startsOn: date,
  periodStartsOn: date,
  endsOn: date.nullable(),
  periodCount: z.int(),
  schedule: habitScheduleSchema.nullable(),
  nextSchedule: habitScheduleSchema.nullable(),
  todayState: z.enum(habitDayStates),
  pausedBy,
  todayCheckin: habitCheckinSchema.nullable(),
  todayBlock: z.enum(habitBlocks).nullable(),
  week: habitWeekSchema.nullable(),
  streak: habitStreakSchema,
  pause: z
    .object({ id: z.uuid(), startsOn: date, resumesOn: date.nullable(), revision: z.int() })
    .nullable(),
  reminders: z.boolean(),
  myReminders: z.boolean(),
  access: z.enum(habitAccessLevels),
  tracking: habitTrackingSchema,
  nextTracking: habitTrackingSchema.nullable(),
  /** Today's progress; null for a habit that is completed once. */
  progress: habitProgressSchema.nullable(),
  /** Why progress cannot be added today, or null when it can. */
  contributionBlock: z.enum(contributionBlocks).nullable(),
});
export type HabitSummary = z.infer<typeof habitSummarySchema>;

export const habitListSchema = z.object({
  habits: z.array(habitSummarySchema),
  counts: z.object({ active: z.int(), ended: z.int(), archived: z.int() }),
  access: z.enum(habitAccessLevels).nullable(),
  memberAccess: z.enum(habitMemberAccess).nullable(),
  celebrations: z.boolean(),
  timeZone: z.string().nullable(),
});
export type HabitList = z.infer<typeof habitListSchema>;

const range = z.object({ startsOn: date, endsOn: date });

export const habitDaySchema = z.object({
  onDate: date,
  state: z.enum(habitDayStates),
  kind: z.enum(habitScheduleKinds).nullable(),
  pausedBy,
});
export type HabitDay = z.infer<typeof habitDaySchema>;

/** A numeric day as the daily totals show it. */
export const habitNumericDaySchema = z.object({
  onDate: date,
  state: z.enum(habitDayStates),
  pausedBy,
  target: z.number(),
  unit: z.string(),
  unitKind: z.enum(habitUnitKinds),
  total: z.number(),
  met: z.boolean(),
  above: z.boolean(),
  note: z.string().nullable(),
  noteRevision: z.int(),
  block: z.enum(contributionBlocks).nullable(),
});
export type HabitNumericDay = z.infer<typeof habitNumericDaySchema>;

export const habitDailyTotalsSchema = z.object({
  days: z.array(habitNumericDaySchema),
  hasMore: z.boolean(),
});
export type HabitDailyTotals = z.infer<typeof habitDailyTotalsSchema>;

export const habitDetailSchema = habitSummarySchema.extend({
  trackings: z.array(habitTrackingSchema),
  numericRecent: z.array(habitNumericDaySchema),
  periods: z.array(z.object({ id: z.uuid(), startsOn: date, endsOn: date.nullable() })),
  schedules: z.array(habitScheduleSchema),
  pauses: z.array(
    z.object({
      id: z.uuid(),
      startsOn: date,
      resumesOn: date.nullable(),
      revision: z.int(),
      current: z.boolean(),
    }),
  ),
  vacationDays: z.array(range),
  recent: z.array(
    habitDaySchema.extend({
      block: z.enum(habitBlocks).nullable(),
      checkin: habitCheckinSchema.nullable(),
    }),
  ),
  weeks: z.array(habitWeekSchema),
  milestones: z.array(
    z.object({
      unit: z.enum(["occurrences", "weeks"]),
      threshold: z.int(),
      reachedOn: date,
      recordedAt: z.string(),
      backdated: z.boolean(),
    }),
  ),
  reminder: z
    .object({
      enabled: z.boolean(),
      times: z.array(z.string()),
      weekdays: z.array(z.int()),
      revision: z.int(),
    })
    .nullable(),
  celebrations: z.boolean(),
});
export type HabitDetail = z.infer<typeof habitDetailSchema>;

export const habitEventKinds = [
  "created",
  "edited",
  "schedule_changed",
  "end_changed",
  "paused",
  "pause_changed",
  "resumed",
  "archived",
  "unarchived",
  "restored",
  "reactivated",
  "reminders_changed",
  "checked_in",
  "undone",
  "corrected",
  "note_added",
  "note_edited",
  "note_removed",
  "vacation_pause_changed",
  "tracking_changed",
  "contribution_corrected",
] as const;

export const habitEventSchema = z.object({
  id: z.uuid(),
  kind: z.enum(habitEventKinds),
  by: person,
  mine: z.boolean(),
  at: z.string(),
  onDate: date.nullable(),
  checkinId: z.uuid().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type HabitEvent = z.infer<typeof habitEventSchema>;

const ratio = z.object({ completed: z.int(), eligible: z.int() });

/** Weekly and monthly quantity summaries: per period and unit family (S29). */
export const habitNumericSummarySchema = z.object({
  periods: z.array(
    z.object({
      kind: z.enum(["week", "month"]),
      startsOn: date,
      endsOn: date,
      soFar: z.boolean(),
      segments: z.array(
        z.object({
          unit: z.string(),
          unitKind: z.enum(habitUnitKinds),
          total: z.number(),
          eligibleDays: z.int(),
          metDays: z.int(),
          average: z.number(),
        }),
      ),
    }),
  ),
});
export type HabitNumericSummary = z.infer<typeof habitNumericSummarySchema>;

export const habitInsightsSchema = z.object({
  days: z.int(),
  from: date,
  to: date,
  completed: z.int(),
  eligible: z.int(),
  trend: z.array(ratio.extend({ weekOn: date })),
  periods: z.array(ratio.extend({ startsOn: date, endsOn: date.nullable() })),
  habit: habitSummarySchema,
  streak: habitStreakSchema,
  scheduleChanges: z.array(habitScheduleSchema),
  pausedDays: z.int(),
  numeric: habitNumericSummarySchema.nullable(),
});
export type HabitInsights = z.infer<typeof habitInsightsSchema>;

export const habitCalendarSchema = z.object({
  month: date,
  today: date,
  weekStart,
  days: z.array(habitDaySchema),
  weeks: z.array(habitWeekSchema),
  numericDays: z.array(habitNumericDaySchema),
});
export type HabitCalendar = z.infer<typeof habitCalendarSchema>;

export const habitMilestoneSchema = z.object({
  threshold: z.int(),
  unit: z.enum(["occurrences", "weeks"]),
  reachedOn: date,
  celebrate: z.boolean(),
});
export type HabitMilestone = z.infer<typeof habitMilestoneSchema>;

/** A check-in answer (`complete_habit`, `undo_habit_checkin`). */
export const habitCheckinResultSchema = z.object({
  outcome: z.string(),
  checkin: habitCheckinSchema.nullable().optional(),
  streakBefore: z.int().nullable().optional(),
  milestone: habitMilestoneSchema.nullable().optional(),
  habit: habitSummarySchema.nullable().optional(),
});
export type HabitCheckinResult = z.infer<typeof habitCheckinResultSchema>;

/** One contribution as the person allowed to see it sees it. */
export const habitContributionSchema = z.object({
  id: z.uuid(),
  onDate: date,
  quantity: z.number(),
  originalQuantity: z.number().nullable(),
  enteredQuantity: z.number().nullable(),
  enteredUnit: z.string().nullable(),
  by: person,
  mine: z.boolean(),
  recordedAt: z.string(),
  source: z.enum(["app", "widget"]),
  status: z.enum(["active", "undone"]),
  amendedAt: z.string().nullable(),
  undoneAt: z.string().nullable(),
  undoKind: z.enum(["undo", "correction"]).nullable(),
  undoReason: z.string().nullable(),
  action: z.enum(["undo", "correct"]).nullable(),
});
export type HabitContribution = z.infer<typeof habitContributionSchema>;

export const habitContributionsSchema = z.object({
  onDate: date,
  /** True for habit managers: every contribution with who added it. */
  all: z.boolean(),
  target: z.number().nullable(),
  unit: z.string().nullable(),
  unitKind: z.enum(habitUnitKinds).nullable(),
  total: z.number(),
  contributions: z.array(habitContributionSchema),
});
export type HabitContributions = z.infer<typeof habitContributionsSchema>;

/** A contribution answer (`add_habit_contribution`, `update_habit_contribution`). */
export const habitContributionResultSchema = z.object({
  outcome: z.string(),
  contributionId: z.uuid().optional(),
  completedNow: z.boolean().optional(),
  reopened: z.boolean().optional(),
  converted: z.number().optional(),
  progress: habitProgressSchema.nullable().optional(),
  streakBefore: z.int().nullable().optional(),
  milestone: habitMilestoneSchema.nullable().optional(),
  habit: habitSummarySchema.nullable().optional(),
});
export type HabitContributionResult = z.infer<typeof habitContributionResultSchema>;

export const vacationHabitsSchema = z.object({
  participation: z.object({ startsOn: date, endsOn: date }).nullable(),
  habits: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      paused: z.boolean(),
      scheduledDays: z.int().nullable(),
    }),
  ),
});
export type VacationHabits = z.infer<typeof vacationHabitsSchema>;
