import { z } from "zod";

import {
  GOAL_LIMITS,
  goalFrequencies,
  goalKinds,
  goalLinkRemovals,
  goalLinkStarts,
  goalViews,
  goalWeekStarts,
  isGoalFrequencyAllowed,
  isValidGoalReminder,
  isValidGoalThousandths,
} from "@madeora/domain/goals";
import { HABIT_QUANTITY, habitUnitKinds, isHabitDate, toThousandths } from "@madeora/domain/habits";
import { goalMemberAccess } from "@madeora/domain/permissions";

import { visibleName } from "@/shopping/schema";
import { clockTimeSchema, plainTextSchema } from "@/tasks/schema";

/**
 * The goals contract (S30, versioned for later mobile clients). Client-safe. Every limit matches the
 * database (`private.goal_limit`, `private.valid_goal_quantity` and `private.valid_goal_shape` in
 * supabase/migrations/*_goals.sql), which checks everything again.
 */

const id = z.uuid();
const revision = z.int().min(1);
export const goalDateSchema = z.string().refine(isHabitDate, "invalid");

export const goalTitleSchema = visibleName(GOAL_LIMITS.title);

/** An optional text: empty (or only whitespace) means none. */
function optionalText(max: number) {
  return z
    .string()
    .transform((value) => (value.trim() === "" ? null : value))
    .pipe(plainTextSchema(max).nullable())
    .nullable()
    .default(null);
}

export const goalDescriptionSchema = optionalText(GOAL_LIMITS.description);
export const goalNoteSchema = optionalText(GOAL_LIMITS.note);
export const goalReasonSchema = optionalText(GOAL_LIMITS.reason);

/**
 * A quantity as the API takes it: a decimal string with at most 3 decimals ("1500", "0.25"), never
 * a localized text (the form parses what the person typed first), or a number that is already exact
 * in 3 decimals. 0 to 1,000,000,000; whether 0 is allowed and whole numbers are needed depends on
 * the use and the unit, which the database checks.
 */
export const goalQuantitySchema = z.union([
  z
    .string()
    .regex(/^\d{1,10}(?:\.\d{1,3})?$/, "invalid")
    .transform(Number)
    .refine((value) => value <= GOAL_LIMITS.max, "invalid"),
  z
    .number()
    .refine(
      (value) =>
        Number.isFinite(value) &&
        value >= 0 &&
        value <= GOAL_LIMITS.max &&
        Math.round(value * 1000) / 1000 === value,
      "invalid",
    ),
]);

const unitLabel = z.string().min(1).max(HABIT_QUANTITY.customUnitLength);
const timeZone = z.string().min(1).max(64);

/** A measurable goal's target and unit: a preset of the habit catalogue or a custom label. */
const measureSchema = z
  .strictObject({
    target: goalQuantitySchema,
    unit: unitLabel,
    unitKind: z.enum(habitUnitKinds),
  })
  .refine(
    (measure) =>
      isValidGoalThousandths(toThousandths(measure.target), {
        unit: measure.unit,
        kind: measure.unitKind,
      }),
    { error: "invalid", path: ["target"] },
  );

export const createGoalSchema = z
  .strictObject({
    id,
    homeId: id.nullable(),
    kind: z.enum(goalKinds),
    title: goalTitleSchema,
    description: goalDescriptionSchema,
    /** Measurable goals only. */
    measure: measureSchema.nullable().default(null),
    /** A measurable goal's starting progress (default 0). */
    initial: goalQuantitySchema.nullable().default(null),
    deadline: goalDateSchema.nullable().default(null),
    /** A personal goal's timezone; ignored for a Home goal (the Home's own). */
    timeZone: timeZone.nullable().default(null),
    /** The completed goal this one renews. */
    renewedFrom: id.nullable().default(null),
  })
  .refine((body) => (body.kind === "measurable") === (body.measure !== null), {
    error: "invalid",
    path: ["measure"],
  })
  .refine(
    (body) =>
      body.initial === null ||
      (body.measure !== null &&
        isValidGoalThousandths(
          toThousandths(body.initial),
          { unit: body.measure.unit, kind: body.measure.unitKind },
          { zero: true },
        )),
    { error: "invalid", path: ["initial"] },
  );
export type CreateGoalInput = z.input<typeof createGoalSchema>;

export const updateGoalSchema = z.strictObject({
  revision,
  title: goalTitleSchema,
  description: goalDescriptionSchema,
  deadline: goalDateSchema.nullable().default(null),
  timeZone: timeZone.nullable().default(null),
});

export const deleteGoalSchema = z.strictObject({ revision });

/** Previews (`preview: true`) or applies a target or unit change. */
export const changeTargetSchema = z
  .strictObject({
    revision,
    target: goalQuantitySchema,
    unit: unitLabel,
    unitKind: z.enum(habitUnitKinds),
    confirmUnit: z.boolean().default(false),
    confirmStatus: z.boolean().default(false),
    preview: z.boolean().default(false),
  })
  .refine(
    (body) =>
      isValidGoalThousandths(toThousandths(body.target), { unit: body.unit, kind: body.unitKind }),
    { error: "invalid", path: ["target"] },
  );

export const entrySources = ["app", "widget"] as const;

/**
 * Progress on a measurable goal: `add` (a positive amount) or `total` (goal managers set the total;
 * `expectedTotal` is the total they saw, so a total that moved meanwhile is refused as stale).
 */
export const addEntrySchema = z
  .strictObject({
    id,
    mode: z.enum(["add", "total"]).default("add"),
    quantity: goalQuantitySchema,
    note: goalNoteSchema,
    source: z.enum(entrySources).default("app"),
    expectedTotal: goalQuantitySchema.nullable().default(null),
  })
  .refine((body) => body.mode === "total" || body.quantity > 0, {
    error: "invalid",
    path: ["quantity"],
  })
  .refine((body) => body.mode === "add" || body.expectedTotal !== null, {
    error: "required",
    path: ["expectedTotal"],
  });

/** A correction: `reverse`, or `amend` to a new quantity (an adjustment may be negative). */
export const updateEntrySchema = z
  .strictObject({
    action: z.enum(["reverse", "amend"]),
    quantity: z
      .union([
        z
          .string()
          .regex(/^-?\d{1,10}(?:\.\d{1,3})?$/, "invalid")
          .transform(Number),
        z.number().refine((value) => Number.isFinite(value), "invalid"),
      ])
      .refine(
        (value) => Math.abs(value) <= GOAL_LIMITS.max && Math.round(value * 1000) / 1000 === value,
        "invalid",
      )
      .nullable()
      .default(null),
    reason: goalReasonSchema,
  })
  .refine((body) => (body.action === "amend") === (body.quantity !== null), {
    error: "invalid",
    path: ["quantity"],
  });

export const achievementSchema = z
  .strictObject({ revision, achieved: z.boolean(), reason: goalReasonSchema })
  .refine((body) => !body.achieved || body.reason === null, {
    error: "invalid",
    path: ["reason"],
  });

export const archiveSchema = z.strictObject({ revision, archived: z.boolean() });

export const remindersSchema = z
  .strictObject({
    /** The reminder revision as read (0: none yet). */
    expectedRevision: z.int().min(0),
    enabled: z.boolean(),
    leadDays: z.int().min(1).max(GOAL_LIMITS.leadDays).nullable().default(null),
    overdueDays: z.int().min(0).max(GOAL_LIMITS.overdueDays).nullable().default(null),
    atTime: clockTimeSchema.default("09:00"),
    preview: z.boolean().default(false),
  })
  .refine((body) => !body.enabled || isValidGoalReminder(body), {
    error: "invalid",
    path: ["leadDays"],
  });

export const myRemindersSchema = z.strictObject({ enabled: z.boolean() });

export const settingsSchema = z.strictObject({
  homeId: id,
  memberAccess: z.enum(goalMemberAccess),
});

export const listQuerySchema = z.object({
  homeId: id.optional(),
  view: z.enum(goalViews).default("active"),
  q: z.string().max(GOAL_LIMITS.query).optional(),
});

/** A page of entries or history: after `before`, the last row of the previous page (none: newest). */
export const pageQuerySchema = z.object({ before: z.uuid().optional() });

/** A series' advance reminder: days before each period's last day, at a local time. */
const seriesReminderSchema = z.strictObject({
  leadDays: z.int().min(1).max(GOAL_LIMITS.leadDays),
  atTime: clockTimeSchema.default("09:00"),
});

/**
 * A recurring series (S30b): a measurable goal repeating weekly, monthly or yearly, or a completion
 * goal monthly or yearly. `firstPeriod` is a date in the first period (this period or a later one);
 * `endsOn`: no period starts after it. `preview: true` answers the first and next periods only.
 */
export const createSeriesSchema = z
  .strictObject({
    id,
    homeId: id.nullable(),
    kind: z.enum(goalKinds),
    frequency: z.enum(goalFrequencies),
    title: goalTitleSchema,
    description: goalDescriptionSchema,
    measure: measureSchema.nullable().default(null),
    weekStart: z.enum(goalWeekStarts).default("monday"),
    firstPeriod: goalDateSchema,
    endsOn: goalDateSchema.nullable().default(null),
    timeZone: timeZone.nullable().default(null),
    reminder: seriesReminderSchema.nullable().default(null),
    preview: z.boolean().default(false),
  })
  .refine((body) => (body.kind === "measurable") === (body.measure !== null), {
    error: "invalid",
    path: ["measure"],
  })
  .refine((body) => isGoalFrequencyAllowed(body.kind, body.frequency), {
    error: "invalid",
    path: ["frequency"],
  })
  .refine((body) => body.endsOn === null || body.endsOn >= body.firstPeriod, {
    error: "invalid",
    path: ["endsOn"],
  });
export type CreateSeriesInput = z.input<typeof createSeriesSchema>;

/** Edits apply to the periods created afterwards. */
export const updateSeriesSchema = z.strictObject({
  revision,
  title: goalTitleSchema,
  description: goalDescriptionSchema,
  endsOn: goalDateSchema.nullable().default(null),
  timeZone: timeZone.nullable().default(null),
  reminder: seriesReminderSchema.nullable().default(null),
});

export const seriesStateSchema = z.strictObject({
  revision,
  action: z.enum(["pause", "resume", "stop"]),
});

/** A target and unit from a period on: `effectiveFrom` is the start of this or a later period. */
export const seriesTargetSchema = z
  .strictObject({
    revision,
    effectiveFrom: goalDateSchema,
    target: goalQuantitySchema,
    unit: unitLabel,
    unitKind: z.enum(habitUnitKinds),
    confirmUnit: z.boolean().default(false),
    confirmStatus: z.boolean().default(false),
    preview: z.boolean().default(false),
  })
  .refine(
    (body) =>
      isValidGoalThousandths(toThousandths(body.target), { unit: body.unit, kind: body.unitKind }),
    { error: "invalid", path: ["target"] },
  );

export const deleteSeriesSchema = z.strictObject({ revision });

// Habit-to-goal links (S30c) ----------------------------------------------------------------------------

/** Exactly one of a goal, a series or a habit, whose links to list. */
export const linksQuerySchema = z
  .object({ goalId: id.optional(), seriesId: id.optional(), habitId: id.optional() })
  .refine((query) => [query.goalId, query.seriesId, query.habitId].filter(Boolean).length === 1, {
    error: "invalid",
  });

/** A goal or a series whose candidate habits to list. */
export const linkCandidatesQuerySchema = z
  .object({ goalId: id.optional(), seriesId: id.optional() })
  .refine((query) => (query.goalId === undefined) !== (query.seriesId === undefined), {
    error: "invalid",
  });

/** Where a link starts: today, a chosen past `startDate`, or the habit's first start date. */
const linkStart = {
  start: z.enum(goalLinkStarts),
  startDate: goalDateSchema.nullable().default(null),
};

/**
 * Confirming needs what the preview showed: the revision (of the goal or series when creating, of
 * the link when changing it) and the linked amount. `preview: true` answers the impact only.
 */
const linkConfirmation = {
  preview: z.boolean().default(false),
  revision: revision.nullable().default(null),
  expectedAmount: goalQuantitySchema.nullable().default(null),
};

function confirmed(body: {
  readonly preview: boolean;
  readonly revision: number | null;
  readonly expectedAmount: number | null;
}): boolean {
  return body.preview || (body.revision !== null && body.expectedAmount !== null);
}

/** Links a numeric habit to a measurable goal or series (exactly one). */
export const createLinkSchema = z
  .strictObject({
    id,
    habitId: id,
    goalId: id.nullable().default(null),
    seriesId: id.nullable().default(null),
    ...linkStart,
    ...linkConfirmation,
  })
  .refine((body) => (body.goalId === null) !== (body.seriesId === null), {
    error: "invalid",
    path: ["goalId"],
  })
  .refine((body) => (body.start === "date") === (body.startDate !== null), {
    error: "invalid",
    path: ["startDate"],
  })
  .refine(confirmed, { error: "invalid", path: ["revision"] });
export type CreateLinkInput = z.input<typeof createLinkSchema>;

/** Changes a link's first counted day. */
export const changeLinkStartSchema = z
  .strictObject({ ...linkStart, ...linkConfirmation })
  .refine((body) => (body.start === "date") === (body.startDate !== null), {
    error: "invalid",
    path: ["startDate"],
  })
  .refine(confirmed, { error: "invalid", path: ["revision"] });

/** Removes a link, keeping its amount as a manual adjustment or taking it out. */
export const removeLinkSchema = z
  .strictObject({ mode: z.enum(goalLinkRemovals), ...linkConfirmation })
  .refine(confirmed, { error: "invalid", path: ["revision"] });
