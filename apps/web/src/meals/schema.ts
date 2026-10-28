import { z } from "zod";

import { isMealDate, isValidCadence, MEAL_LIMITS, mealCadences } from "@madeora/domain/meals";

import { visibleName } from "@/shopping/schema";
import { addRowSchema } from "@/shopping/schema";

/**
 * The meal-planner contract (S27, versioned for later mobile clients). Client-safe. Every limit
 * matches the database (`private.meal_limit`, `private.valid_meal_content` and
 * `private.valid_meal_cadence` in supabase/migrations/*_meal_planner.sql), which checks everything
 * again.
 */

// Tab, line feed and carriage return are the only control characters plain text may hold.
// eslint-disable-next-line no-control-regex -- the point of the check is control characters
const forbiddenControls = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const id = z.uuid();
const revision = z.number().int().min(1);
export const mealDateSchema = z.string().refine(isMealDate, "invalid");

export const slotNameSchema = visibleName(MEAL_LIMITS.slotName);
export const mealTitleSchema = visibleName(MEAL_LIMITS.title);
export const mealNotesSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "required")
  .refine((value) => Array.from(value).length <= MEAL_LIMITS.notes, "tooLong")
  .refine((value) => !forbiddenControls.test(value), "invalidCharacters");
export const servingsSchema = z.number().int().min(1).max(MEAL_LIMITS.maxServings);

/** The fingerprint of what occupies a slot, from an `occupied` answer, to replace it explicitly. */
const replaceSchema = z.string().min(1).max(4000).nullable().default(null);

const content = {
  recipeId: id.nullable().default(null),
  title: mealTitleSchema.nullable().default(null),
  notes: mealNotesSchema.nullable().default(null),
  servings: servingsSchema.nullable().default(null),
};

/** A new meal: a recipe or a custom title, never both; servings only with a recipe. */
export const createEntrySchema = z
  .strictObject({
    id,
    homeId: id.nullable(),
    date: mealDateSchema,
    slotId: id,
    ...content,
    replace: replaceSchema,
  })
  .refine((body) => (body.recipeId === null) !== (body.title === null), {
    error: "required",
    path: ["title"],
  })
  .refine((body) => body.servings === null || body.recipeId !== null, {
    error: "invalid",
    path: ["servings"],
  });

/**
 * An edit or move. A recipe meal sent with neither a recipe nor a title keeps its recipe (also one
 * the person can no longer see); the database decides that against the stored meal.
 */
export const updateEntrySchema = z
  .strictObject({ revision, date: mealDateSchema, slotId: id, ...content, replace: replaceSchema })
  .refine((body) => body.recipeId === null || body.title === null, {
    error: "invalid",
    path: ["title"],
  });

export const deleteEntrySchema = z.strictObject({ revision });

/** Edit or move one occurrence of a repeating meal: it becomes a meal of its own (`entryId`). */
export const editOccurrenceSchema = z
  .strictObject({
    entryId: id,
    date: mealDateSchema,
    slotId: id,
    ...content,
    replace: replaceSchema,
  })
  .refine((body) => body.recipeId === null || body.title === null, {
    error: "invalid",
    path: ["title"],
  });

const weekday = z.literal([1, 2, 3, 4, 5, 6, 7]);
const scheduleFields = {
  slotId: id,
  cadence: z.enum(mealCadences),
  weekdays: z.array(weekday).max(7).nullable(),
  endOn: mealDateSchema.nullable().default(null),
};
const validSchedule = (body: {
  cadence: (typeof mealCadences)[number];
  weekdays: readonly number[] | null;
}) => isValidCadence(body.cadence, body.weekdays);

export const seriesPreviewSchema = z
  .strictObject({
    action: z.literal("preview"),
    homeId: id.nullable(),
    startOn: mealDateSchema,
    ...scheduleFields,
  })
  .refine(validSchedule, { error: "weekdaysRequired", path: ["weekdays"] });

/** Each collision's choice: skip the new occurrence that day, or replace what is there. */
const decisionsSchema = z.record(z.string().refine(isMealDate), z.enum(["skip", "replace"]));

export const seriesCreateSchema = z
  .strictObject({
    action: z.literal("create"),
    id,
    homeId: id.nullable(),
    startOn: mealDateSchema,
    ...scheduleFields,
    ...content,
    token: z.string().max(64),
    decisions: decisionsSchema.default({}),
  })
  .refine(validSchedule, { error: "weekdaysRequired", path: ["weekdays"] })
  .refine((body) => (body.recipeId === null) !== (body.title === null), {
    error: "required",
    path: ["title"],
  })
  .refine((body) => body.servings === null || body.recipeId !== null, {
    error: "invalid",
    path: ["servings"],
  });

export const seriesUpdateSchema = z.discriminatedUnion("action", [
  /** The collisions of an edit or resume from `from` (a resume sends the series' own schedule). */
  z.strictObject({
    action: z.literal("preview"),
    homeId: id.nullable(),
    from: mealDateSchema,
    ...scheduleFields,
  }),
  z.strictObject({
    action: z.literal("editFuture"),
    revision,
    from: mealDateSchema,
    ...scheduleFields,
    ...content,
    token: z.string().max(64),
    decisions: decisionsSchema.default({}),
  }),
  z.strictObject({ action: z.literal("pause"), revision }),
  z.strictObject({
    action: z.literal("resume"),
    revision,
    from: mealDateSchema,
    token: z.string().max(64),
    decisions: decisionsSchema.default({}),
  }),
  z.strictObject({ action: z.literal("end"), revision, from: mealDateSchema }),
]);

export const createSlotSchema = z.strictObject({ id, homeId: id.nullable(), name: slotNameSchema });
export const updateSlotSchema = z.strictObject({
  revision,
  /** null: back to the standard name (standard slots only). */
  name: slotNameSchema.nullable(),
  enabled: z.boolean(),
  impactToken: z.string().max(64).nullable().default(null),
});
export const moveSlotSchema = z.strictObject({ direction: z.enum(["up", "down"]) });
export const settingsSchema = z.strictObject({
  homeId: id,
  revision: z.number().int().min(0),
  memberAccess: z.enum(["edit", "view"]),
});

export const copyQuerySchema = z.strictObject({
  homeId: id.optional(),
  source: mealDateSchema,
  destination: mealDateSchema,
});
export const copySchema = z.strictObject({
  homeId: id.nullable(),
  source: mealDateSchema,
  destination: mealDateSchema,
  token: z.string().max(64),
  rows: z
    .array(
      z.strictObject({ key: z.string().min(1).max(200), id, replace: z.boolean().default(false) }),
    )
    .min(1)
    .max(MEAL_LIMITS.copyRows)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "invalid"),
});

export const transferQuerySchema = z.strictObject({
  homeId: id.optional(),
  from: mealDateSchema,
  to: mealDateSchema,
});
/** Rows one transfer adds at most (the shopping list's limit for one multi-add). */
export const MEAL_TRANSFER_MAX_ROWS = 100;

export const transferSchema = z.strictObject({
  id,
  homeId: id.nullable(),
  from: mealDateSchema,
  to: mealDateSchema,
  listId: id,
  token: z.string().max(64),
  items: z
    .array(addRowSchema)
    .min(1)
    .max(MEAL_TRANSFER_MAX_ROWS)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "invalid"),
});

export const planQuerySchema = z.strictObject({
  homeId: id.optional(),
  from: mealDateSchema.optional(),
  to: mealDateSchema.optional(),
});

export const recipesQuerySchema = z.strictObject({
  homeId: id.optional(),
  q: z.string().max(100).optional(),
});
