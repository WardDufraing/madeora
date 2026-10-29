import { z } from "zod";

import {
  HABIT_LIMITS,
  HABIT_QUANTITY,
  habitInsightDays,
  habitScheduleKinds,
  habitSnoozeMinutes,
  habitUnitKinds,
  habitViews,
  habitWeekStarts,
  isHabitDate,
  isValidHabitReminder,
  isValidHabitSchedule,
  isValidNumericTracking,
  toThousandths,
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

/**
 * A quantity as the API takes it: a decimal string with at most 3 decimals ("1500", "1.5"), never a
 * localized text (the form parses what the person typed first). A number is accepted when it is
 * already exact in 3 decimals, so a parsed body can be sent as it is. Becomes a number; the database
 * checks the range and the unit's rules again.
 */
export const quantitySchema = z.union([
  z
    .string()
    .regex(/^\d{1,7}(?:\.\d{1,3})?$/, "invalid")
    .transform(Number),
  z
    .number()
    .refine(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        value <= HABIT_QUANTITY.max &&
        Math.round(value * 1000) / 1000 === value,
      "invalid",
    ),
]);

const unitLabel = z.string().min(1).max(HABIT_QUANTITY.customUnitLength);

/** A numeric daily target with its unit and quick-add presets. */
export const habitTrackingInputSchema = z
  .strictObject({
    target: quantitySchema,
    unit: unitLabel,
    unitKind: z.enum(habitUnitKinds),
    quickAdds: z.array(quantitySchema).max(HABIT_QUANTITY.quickAdds).default([]),
  })
  .refine(
    (tracking) =>
      isValidNumericTracking({
        unit: tracking.unit,
        unitKind: tracking.unitKind,
        target: toThousandths(tracking.target),
        quickAdds: tracking.quickAdds.map(toThousandths),
      }),
    { error: "invalid", path: ["target"] },
  );

export const createHabitSchema = z
  .strictObject({
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
    /** null: completed once a day. A numeric target needs a daily or weekdays schedule. */
    tracking: habitTrackingInputSchema.nullable().default(null),
  })
  .refine((body) => body.tracking === null || body.schedule.kind !== "weekly", {
    error: "invalid",
    path: ["tracking"],
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

export const trackingWhen = ["today", "next", "date"] as const;

/** Previews or applies a tracking change (S29). `tracking: null` goes back to completing once. */
export const changeTrackingSchema = z
  .strictObject({
    revision,
    tracking: habitTrackingInputSchema.nullable(),
    when: z.enum(trackingWhen),
    effectiveOn: habitDateSchema.nullable().default(null),
    /** Today's total as the preview showed it; a moved total is refused (`stale`). */
    expectedTotal: z
      .number()
      .min(0)
      .max(HABIT_QUANTITY.max * 2)
      .nullable()
      .default(null),
    confirmStatus: z.boolean().default(false),
    confirmUnit: z.boolean().default(false),
    preview,
  })
  .refine((body) => body.when !== "date" || body.effectiveOn !== null, {
    error: "required",
    path: ["effectiveOn"],
  });

export const quickAddsSchema = z.strictObject({
  revision,
  quickAdds: z.array(quantitySchema).max(HABIT_QUANTITY.quickAdds),
});

export const contributionSources = ["app", "widget"] as const;

export const addContributionSchema = z.strictObject({
  id,
  quantity: quantitySchema,
  /** null: the habit's today. */
  onDate: habitDateSchema.nullable().default(null),
  /** The unit the person typed it in, when not the habit's own (converted exactly by the database). */
  enteredUnit: unitLabel.nullable().default(null),
  source: z.enum(contributionSources).default("app"),
  /** A widget's habit revision as read, so a stale preset is refused. */
  revision: revision.nullable().default(null),
});

export const updateContributionSchema = z
  .strictObject({
    action: z.enum(["undo", "void", "amend"]),
    quantity: quantitySchema.nullable().default(null),
    reason: habitReasonSchema,
  })
  .refine((body) => body.action !== "amend" || body.quantity !== null, {
    error: "required",
    path: ["quantity"],
  });

export const dayNoteSchema = z.strictObject({
  /** The note revision as read (0: none yet). */
  revision: z.int().min(0),
  note: habitNoteSchema,
});

export const contributionsQuerySchema = z.object({ on: habitDateSchema });

export const daysQuerySchema = z.object({ before: habitDateSchema.optional() });
