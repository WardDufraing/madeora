import { z } from "zod";

import { habitDayStates, habitScheduleKinds, habitStatuses } from "@madeora/domain/habits";
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

export const habitDetailSchema = habitSummarySchema.extend({
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
});
export type HabitInsights = z.infer<typeof habitInsightsSchema>;

export const habitCalendarSchema = z.object({
  month: date,
  today: date,
  weekStart,
  days: z.array(habitDaySchema),
  weeks: z.array(habitWeekSchema),
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
