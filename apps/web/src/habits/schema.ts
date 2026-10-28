import { z } from "zod";

import {
  HABIT_LIMITS,
  habitInsightDays,
  habitScheduleKinds,
  habitSnoozeMinutes,
  habitViews,
  habitWeekStarts,
  isHabitDate,
  isValidHabitReminder,
  isValidHabitSchedule,
} from "@madeora/domain/habits";
import { habitMemberAccess } from "@madeora/domain/permissions";

import { visibleName } from "@/shopping/schema";
import { clockTimeSchema, plainTextSchema } from "@/tasks/schema";

/**
 * The habits contract (S28, versioned for later mobile clients). Client-safe. Every limit matches
 * the database (`private.habit_limit`, `private.valid_habit_schedule` and
 * `private.valid_habit_reminder` in supabase/migrations/*_habits.sql), which checks everything again.
 */

const id = z.uuid();
const revision = z.int().min(1);
export const habitDateSchema = z.string().refine(isHabitDate, "invalid");
const preview = z.boolean().default(false);

export const habitNameSchema = visibleName(HABIT_LIMITS.name);

/** An optional text: empty (or only whitespace) means none. */
function optionalText(max: number) {
  return z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(plainTextSchema(max).nullable())
    .nullable()
    .default(null);
}

export const habitDescriptionSchema = optionalText(HABIT_LIMITS.description);
export const habitNoteSchema = optionalText(HABIT_LIMITS.note);
export const habitReasonSchema = optionalText(HABIT_LIMITS.reason);

const weekday = z.int().min(1).max(7);

/** A schedule: daily, chosen weekdays, or a weekly target of 1–7 days. */
export const habitScheduleInputSchema = z
  .strictObject({
    kind: z.enum(habitScheduleKinds),
    weekdays: z.array(weekday).max(7).nullable().default(null),
    target: z.int().min(1).max(7).nullable().default(null),
  })
  .refine((schedule) => isValidHabitSchedule(schedule), { error: "invalid", path: ["kind"] });

const timeZone = z.string().min(1).max(64);

export const createHabitSchema = z.strictObject({
  id,
  homeId: id.nullable(),
  name: habitNameSchema,
  description: habitDescriptionSchema,
  schedule: habitScheduleInputSchema,
  startsOn: habitDateSchema,
  endsOn: habitDateSchema.nullable().default(null),
  /** A personal habit's timezone; ignored for a Home habit (the Home's own). */
  timeZone: timeZone.nullable().default(null),
  weekStart: z.enum(habitWeekStarts),
});
export type CreateHabitInput = z.input<typeof createHabitSchema>;

export const updateHabitSchema = z.strictObject({
  revision,
  name: habitNameSchema,
  description: habitDescriptionSchema,
  timeZone: timeZone.nullable().default(null),
});

export const deleteHabitSchema = z.strictObject({ revision });

export const changeScheduleSchema = z.strictObject({
  revision,
  schedule: habitScheduleInputSchema,
  effectiveOn: habitDateSchema.nullable().default(null),
  preview,
});

export const setEndSchema = z.strictObject({
  revision,
  endsOn: habitDateSchema.nullable(),
  preview,
});

export const reminderModes = ["keep", "change", "off"] as const;

const reminderTimes = z.array(clockTimeSchema).min(1).max(HABIT_LIMITS.reminderTimes);
const reminderWeekdays = z.array(weekday).min(1).max(7);

export const reactivateSchema = z
  .strictObject({
    revision,
    startsOn: habitDateSchema,
    endsOn: habitDateSchema.nullable().default(null),
    schedule: habitScheduleInputSchema,
    reminder: z.strictObject({
      mode: z.enum(reminderModes),
      times: reminderTimes.nullable().default(null),
      weekdays: reminderWeekdays.nullable().default(null),
    }),
    preview,
  })
  .refine(
    (body) =>
      body.reminder.mode !== "change" ||
      (body.reminder.times !== null &&
        body.reminder.weekdays !== null &&
        isValidHabitReminder(body.reminder.times, body.reminder.weekdays)),
    { error: "invalid", path: ["reminder"] },
  );

export const pauseSchema = z.strictObject({
  revision,
  /** The day it resumes (exclusive); null: until resumed. */
  resumesOn: habitDateSchema.nullable().default(null),
  preview,
});

export const updatePauseSchema = z
  .strictObject({
    revision,
    action: z.enum(["resume", "change"]),
    resumesOn: habitDateSchema.nullable().default(null),
    preview,
  })
  .refine((body) => body.action === "resume" || body.resumesOn !== null, {
    error: "required",
    path: ["resumesOn"],
  });

export const archiveSchema = z.strictObject({ revision, archived: z.boolean() });

export const remindersSchema = z
  .strictObject({
    /** The reminder revision as read (0: none yet). */
    expectedRevision: z.int().min(0),
    enabled: z.boolean(),
    times: reminderTimes.nullable().default(null),
    weekdays: reminderWeekdays.nullable().default(null),
  })
  .refine(
    (body) =>
      !body.enabled ||
      (body.times !== null &&
        body.weekdays !== null &&
        isValidHabitReminder(body.times, body.weekdays)),
    { error: "invalid", path: ["times"] },
  );

export const myRemindersSchema = z.strictObject({ enabled: z.boolean() });

export const checkinSources = ["app", "widget", "notification"] as const;

export const completeSchema = z.strictObject({
  id,
  /** null: the habit's today (a weekly habit's reminder). */
  onDate: habitDateSchema.nullable().default(null),
  note: habitNoteSchema,
  source: z.enum(checkinSources).default("app"),
});

export const undoSchema = z.strictObject({ reason: habitReasonSchema });

export const noteSchema = z.strictObject({
  /** The note revision as read. */
  revision: z.int().min(0),
  note: habitNoteSchema,
});

export const snoozeSchema = z.strictObject({
  minutes: z.union(habitSnoozeMinutes.map((minutes) => z.literal(minutes))),
});

export const settingsSchema = z.union([
  z.strictObject({ homeId: id, memberAccess: z.enum(habitMemberAccess) }),
  z.strictObject({ celebrations: z.boolean() }),
]);

export const vacationHabitSchema = z.strictObject({ habitId: id, paused: z.boolean() });

export const listQuerySchema = z.object({
  homeId: id.optional(),
  view: z.enum(habitViews).default("active"),
  q: z.string().max(HABIT_LIMITS.query).optional(),
});

export const insightsQuerySchema = z.object({
  days: z.coerce
    .number()
    .pipe(z.union(habitInsightDays.map((days) => z.literal(days))))
    .default(30),
});

export const calendarQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .refine((value) => isHabitDate(`${value}-01`)),
});

export const historyQuerySchema = z.object({
  kind: z.enum(["checkins", "events"]).default("events"),
  /** The last row of the previous page (a check-in or event id). */
  before: z.uuid().optional(),
});
