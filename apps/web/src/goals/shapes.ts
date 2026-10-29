import { z } from "zod";

import { goalEntryKinds, goalKinds, goalReminderKinds, goalStatuses } from "@madeora/domain/goals";
import { habitUnitKinds } from "@madeora/domain/habits";
import { goalAccessLevels, goalMemberAccess } from "@madeora/domain/permissions";

/**
 * The shapes the goal database functions answer (S30; supabase/migrations/*_goals.sql), checked on
 * the server before anything reaches a page, and the types the interface uses. Client-safe. People
 * are membership references (`null`: a personal goal, or someone who left the Home). Quantities are
 * exact decimals in at most 3 decimals; the interface works in thousandths.
 */

const date = z.iso.date();
const person = z.uuid().nullable();

export const goalSummarySchema = z.object({
  id: z.uuid(),
  homeId: z.uuid().nullable(),
  kind: z.enum(goalKinds),
  title: z.string(),
  description: z.string().nullable(),
  timeZone: z.string(),
  today: date,
  revision: z.int(),
  status: z.enum(goalStatuses),
  deadline: date.nullable(),
  target: z.number().nullable(),
  unit: z.string().nullable(),
  unitKind: z.enum(habitUnitKinds).nullable(),
  /** The exact sum of the active entries (0 for a completion goal). */
  total: z.number(),
  reached: z.boolean(),
  achievedAt: z.string().nullable(),
  achievedBy: person,
  achievedByMe: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  renewedFrom: z.object({ id: z.uuid(), title: z.string() }).nullable(),
  /** The goal's deadline reminders are on. */
  reminders: z.boolean(),
  /** The viewer receives them (a Home goal: not turned off for themselves). */
  myReminders: z.boolean(),
  access: z.enum(goalAccessLevels),
  /** What the viewer may do now. */
  actions: z.object({
    contribute: z.boolean(),
    setTotal: z.boolean(),
    achieve: z.boolean(),
    reopen: z.boolean(),
    manage: z.boolean(),
  }),
});
export type GoalSummary = z.infer<typeof goalSummarySchema>;

export const goalListSchema = z.object({
  goals: z.array(goalSummarySchema),
  counts: z.object({ active: z.int(), completed: z.int(), archived: z.int() }),
  /** The viewer's access in this context (null: none, which the database answers as not found). */
  access: z.enum(goalAccessLevels).nullable(),
  /** A Home's member access; null for the Personal space. */
  memberAccess: z.enum(goalMemberAccess).nullable(),
  /** A Home's timezone; null for the Personal space. */
  timeZone: z.string().nullable(),
});
export type GoalList = z.infer<typeof goalListSchema>;

export const goalAchievementSchema = z.object({
  id: z.uuid(),
  achievedAt: z.string(),
  by: person,
  mine: z.boolean(),
  /** Null for a completion goal. */
  total: z.number().nullable(),
  target: z.number().nullable(),
  /** The unit at that moment (null for a completion goal). */
  unit: z.string().nullable(),
  unitKind: z.enum(habitUnitKinds).nullable(),
  reopenedAt: z.string().nullable(),
  reopenedBy: person,
  reopenedByMe: z.boolean(),
  reason: z.string().nullable(),
});
export type GoalAchievement = z.infer<typeof goalAchievementSchema>;

export const goalMomentSchema = z.object({
  kind: z.enum(goalReminderKinds),
  at: z.string(),
  /** Already passed: skipped, never sent late. */
  passed: z.boolean(),
});
export type GoalMoment = z.infer<typeof goalMomentSchema>;

export const goalReminderSchema = z.object({
  enabled: z.boolean(),
  leadDays: z.int().nullable(),
  overdueDays: z.int().nullable(),
  atTime: z.string(),
  revision: z.int(),
  moments: z.array(goalMomentSchema),
});
export type GoalReminder = z.infer<typeof goalReminderSchema>;

export const goalDetailSchema = goalSummarySchema.extend({
  achievements: z.array(goalAchievementSchema),
  /** Null until reminders were first set. */
  reminder: goalReminderSchema.nullable(),
  entryCount: z.int(),
});
export type GoalDetail = z.infer<typeof goalDetailSchema>;

export const goalCorrectionSchema = z.object({
  action: z.enum(["amend", "reverse"]),
  before: z.number(),
  after: z.number().nullable(),
  by: person,
  mine: z.boolean(),
  at: z.string(),
  reason: z.string().nullable(),
});
export type GoalCorrection = z.infer<typeof goalCorrectionSchema>;

export const goalEntrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(goalEntryKinds),
  /** The current signed quantity. */
  quantity: z.number(),
  /** The first quantity of an amended entry. */
  originalQuantity: z.number().nullable(),
  /** The goal's unit when it was recorded (a later unit change never rewrites it). */
  unit: z.string(),
  unitKind: z.enum(habitUnitKinds),
  note: z.string().nullable(),
  by: person,
  mine: z.boolean(),
  recordedAt: z.string(),
  source: z.enum(["app", "widget"]),
  status: z.enum(["active", "reversed"]),
  amendedAt: z.string().nullable(),
  reversedAt: z.string().nullable(),
  corrections: z.array(goalCorrectionSchema),
  /** What the viewer may do with it now: a manager's correction, their own reversal, or nothing. */
  action: z.enum(["correct", "reverse"]).nullable(),
});
export type GoalEntry = z.infer<typeof goalEntrySchema>;

export const goalEntriesSchema = z.object({
  entries: z.array(goalEntrySchema),
  hasMore: z.boolean(),
});
export type GoalEntries = z.infer<typeof goalEntriesSchema>;

export const goalEventKinds = [
  "created",
  "edited",
  "target_changed",
  "adjusted",
  "corrected",
  "achieved",
  "reopened",
  "archived",
  "unarchived",
  "restored",
  "reminders_changed",
] as const;
export type GoalEventKind = (typeof goalEventKinds)[number];

export const goalEventSchema = z.object({
  id: z.uuid(),
  kind: z.enum(goalEventKinds),
  by: person,
  mine: z.boolean(),
  at: z.string(),
  entryId: z.uuid().nullable(),
  /** Codes and numbers only (never note text). */
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type GoalEvent = z.infer<typeof goalEventSchema>;

export const goalEventsSchema = z.object({
  events: z.array(goalEventSchema),
  hasMore: z.boolean(),
});
export type GoalEvents = z.infer<typeof goalEventsSchema>;

/** A target change's impact (preview, or why it needs confirming). */
export const goalTargetImpactSchema = z.object({
  targetBefore: z.number().nullable(),
  targetAfter: z.number(),
  unitBefore: z.string().nullable(),
  unitKindBefore: z.enum(habitUnitKinds).nullable(),
  unitAfter: z.string(),
  unitKindAfter: z.enum(habitUnitKinds),
  unitChanged: z.boolean(),
  total: z.number(),
  reachedBefore: z.boolean(),
  reachedAfter: z.boolean(),
  achieved: z.boolean(),
  reopens: z.boolean(),
});
export type GoalTargetImpact = z.infer<typeof goalTargetImpactSchema>;

export const goalTargetResultSchema = z.object({
  outcome: z.string(),
  revision: z.int().optional(),
  impact: goalTargetImpactSchema.optional(),
  goal: goalSummarySchema.optional(),
});
export type GoalTargetResult = z.infer<typeof goalTargetResultSchema>;

export const goalEntryResultSchema = z.object({
  outcome: z.string(),
  entryId: z.uuid().optional(),
  totalBefore: z.number().optional(),
  goal: goalSummarySchema.optional(),
});
export type GoalEntryResult = z.infer<typeof goalEntryResultSchema>;

export const goalAchievementResultSchema = z.object({
  outcome: z.string(),
  revision: z.int().optional(),
  goal: goalSummarySchema.optional(),
});
export type GoalAchievementResult = z.infer<typeof goalAchievementResultSchema>;

export const goalRemindersResultSchema = z.object({
  outcome: z.string(),
  revision: z.int().optional(),
  moments: z.array(goalMomentSchema).optional(),
});
export type GoalRemindersResult = z.infer<typeof goalRemindersResultSchema>;
