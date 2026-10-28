import { z } from "zod";

import {
  isShoppingQuantity,
  isValidSchedule,
  SHOPPING_LIMITS,
  shoppingFrequencies,
  shoppingUnits,
  type IsoWeekday,
} from "@madeora/domain/shopping";

import { nameProblem, normalizeName } from "@/names/visible-name";

/**
 * The shopping contract (S26, versioned for later mobile clients). Client-safe. Every limit matches
 * the database (`private.shopping_limit` and `private.valid_shopping_fields` in
 * supabase/migrations/*_shopping_lists.sql), which checks everything again.
 */

/** Field error codes the forms translate. */
export type ShoppingFieldError =
  | "required"
  | "tooLong"
  | "invalidCharacters"
  | "invalidQuantity"
  | "unitNeedsQuantity"
  | "weekdaysRequired"
  | "invalid";

// Tab, line feed and carriage return are the only control characters plain text may hold.
// eslint-disable-next-line no-control-regex -- the point of the check is control characters
const forbiddenControls = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** A visible name (S09 policy, `private.is_visible_name`), normalized as stored. */
export function visibleName(max: number) {
  return z
    .string()
    .max(4 * max, { error: "tooLong" satisfies ShoppingFieldError })
    .transform((value, context) => {
      const name = normalizeName(value);
      const problem = name === "" ? "required" : nameProblem(name, max);
      if (problem) {
        context.addIssue({
          code: "custom",
          message: (problem === "required"
            ? "required"
            : problem === "tooLong"
              ? "tooLong"
              : "invalidCharacters") satisfies ShoppingFieldError,
        });
        return z.NEVER;
      }
      return name;
    });
}

/** Plain multi-line text: at most `max` characters (code points), not only whitespace. */
function plainText(max: number) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, "required")
    .refine((value) => Array.from(value).length <= max, "tooLong")
    .refine((value) => !forbiddenControls.test(value), "invalidCharacters");
}

const id = z.uuid();
const revision = z.number().int().min(1);
const direction = z.enum(["up", "down"]);

export const listNameSchema = visibleName(SHOPPING_LIMITS.listName);
export const categoryNameSchema = visibleName(SHOPPING_LIMITS.categoryName);
export const itemNameSchema = visibleName(SHOPPING_LIMITS.itemName);
export const packagingSchema = visibleName(SHOPPING_LIMITS.packaging);
export const notesSchema = plainText(SHOPPING_LIMITS.notes);

/** A canonical decimal string ("1.25"); the forms read "1,25" with `parseShoppingQuantity` first. */
export const quantitySchema = z.string().refine(isShoppingQuantity, "invalidQuantity");
export const unitSchema = z.enum(shoppingUnits);

/** An item's details as the API takes them: a unit needs a quantity. */
export const itemFieldsSchema = z
  .strictObject({
    name: itemNameSchema,
    quantity: quantitySchema.nullable().default(null),
    unit: unitSchema.nullable().default(null),
    packaging: packagingSchema.nullable().default(null),
    notes: notesSchema.nullable().default(null),
    categoryId: id.nullable().default(null),
  })
  .refine((item) => item.unit === null || item.quantity !== null, {
    error: "unitNeedsQuantity",
    path: ["unit"],
  });
export type ShoppingItemFields = z.output<typeof itemFieldsSchema>;

export const createListSchema = z.strictObject({
  id,
  name: listNameSchema,
  homeId: id.nullable(),
});

export const updateListSchema = z.strictObject({
  revision,
  name: listNameSchema,
  memberAccess: z.enum(["edit", "check", "view"]),
  archived: z.boolean(),
});

export const revisionSchema = z.strictObject({ revision });
export const moveSchema = z.strictObject({ direction });

export const createCategorySchema = z.strictObject({ id, name: categoryNameSchema });
export const updateCategorySchema = z.union([
  z.strictObject({ revision, name: categoryNameSchema }),
  z.strictObject({ direction }),
]);

/** One row of an add: its own client id, so a retry never adds it twice. */
const addRowSchema = z
  .strictObject({
    id,
    name: itemNameSchema,
    quantity: quantitySchema.nullable().default(null),
    unit: unitSchema.nullable().default(null),
    packaging: packagingSchema.nullable().default(null),
    notes: notesSchema.nullable().default(null),
    categoryId: id.nullable().default(null),
    allowDuplicate: z.boolean().default(false),
  })
  .refine((item) => item.unit === null || item.quantity !== null, {
    error: "unitNeedsQuantity",
    path: ["unit"],
  });

export const addItemsSchema = z.strictObject({
  items: z
    .array(addRowSchema)
    .min(1)
    .max(SHOPPING_LIMITS.batch)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "invalid"),
});
export type ShoppingAddRow = z.input<typeof addRowSchema>;

export const clearCompletedSchema = z.strictObject({
  itemIds: z.array(id).min(1).max(SHOPPING_LIMITS.items),
});

export const updateItemSchema = z
  .strictObject({
    revision,
    name: itemNameSchema,
    quantity: quantitySchema.nullable(),
    unit: unitSchema.nullable(),
    packaging: packagingSchema.nullable(),
    notes: notesSchema.nullable(),
    categoryId: id.nullable(),
  })
  .refine((item) => item.unit === null || item.quantity !== null, {
    error: "unitNeedsQuantity",
    path: ["unit"],
  });

export const completionSchema = z.strictObject({
  completed: z.boolean(),
  /** The completion the person saw when reopening (a newer one answers conflict). */
  seenCompletedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const transferSchema = z
  .strictObject({
    mode: z.enum(["move", "copy"]),
    destinationListId: id,
    revision,
    categoryId: id.nullable(),
    keepCompleted: z.boolean(),
    allowDuplicate: z.boolean(),
    /** The copy's client id (copy only). */
    copyId: id.nullable(),
  })
  .refine((body) => (body.mode === "copy") === (body.copyId !== null), {
    error: "invalid",
    path: ["copyId"],
  });

const isoDay = z.iso.date();
const weekday = z.literal([1, 2, 3, 4, 5, 6, 7] satisfies IsoWeekday[]);

/** A recurring schedule: daily, weekly on chosen weekdays, or monthly on a day (1–31). */
export const scheduleSchema = z
  .strictObject({
    frequency: z.enum(shoppingFrequencies),
    weekdays: z.array(weekday).max(7).nullable(),
    monthDay: z.number().int().min(1).max(31).nullable(),
    startOn: isoDay.nullable(),
  })
  .refine(isValidSchedule, "invalid");
export type ShoppingScheduleInput = z.output<typeof scheduleSchema>;

export const startRecurrenceSchema = z.strictObject({ id, schedule: scheduleSchema });

export const updateRecurrenceSchema = z.union([
  z.strictObject({
    revision,
    action: z.literal("schedule"),
    schedule: scheduleSchema,
    /** Take the rule's details from this item of the rule (the item editor's save). */
    fromItemId: id.nullable(),
  }),
  z.strictObject({ revision, action: z.enum(["pause", "resume", "stop"]) }),
]);

/** `GET /api/v1/shopping/widget?homeId&listIds&limit`. */
export const widgetCounts = [5, 10, 15] as const;
export const widgetQuerySchema = z.strictObject({
  homeId: id.nullable(),
  listIds: z
    .array(id)
    .max(SHOPPING_LIMITS.widgetLists)
    .refine((ids) => new Set(ids).size === ids.length, "invalid"),
  limit: z.union([z.literal(5), z.literal(10), z.literal(15)]),
});
