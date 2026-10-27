import { z } from "zod";

import {
  isRecipeUnit,
  isValidQuantity,
  parseQuantity,
  quantityStyles,
  RECIPE_LIMITS,
  type Quantity,
  type RecipeUnit,
} from "@madeora/domain/recipes";

import { nameProblem, normalizeName } from "@/names/visible-name";

/**
 * The recipes contract (S24, versioned for later mobile clients). Client-safe. Every limit matches
 * the database (`private.recipe_limit` and `private.valid_recipe_content` in
 * supabase/migrations/*_recipes.sql), which checks everything again.
 */
export const RECIPE_FIELD_LIMITS = {
  name: 200,
  ingredients: 100,
  ingredientName: 200,
  ingredientNote: 200,
  steps: 100,
  step: 2000,
  notes: 5000,
  tags: 20,
  tag: 40,
  servingsLabel: 40,
  maxMinutes: 10080,
  page: 24,
  maxOffset: 10000,
  query: 100,
  widget: 5,
  /** A cover: JPEG, PNG or WebP up to 10 MB, stored as a WebP of at most 1600 px. */
  coverBytes: 10 * 1024 * 1024,
} as const;

export const recipeSorts = [
  "name_asc",
  "name_desc",
  "added_desc",
  "added_asc",
  "updated_desc",
  "updated_asc",
] as const;
export type RecipeSort = (typeof recipeSorts)[number];

export const recipeWidgetModes = ["favorites", "recent", "top_rated", "random"] as const;
export type RecipeWidgetMode = (typeof recipeWidgetModes)[number];

export const coverTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type CoverType = (typeof coverTypes)[number];

export function isCoverType(value: unknown): value is CoverType {
  return typeof value === "string" && (coverTypes as readonly string[]).includes(value);
}

/** Field error codes the forms translate. */
export type RecipeFieldError =
  | "required"
  | "tooLong"
  | "invalidCharacters"
  | "invalidQuantity"
  | "invalidNumber"
  | "duplicateTag"
  | "tooMany"
  | "invalid";

// Tab, line feed and carriage return are the only control characters plain text may hold.
// eslint-disable-next-line no-control-regex -- the point of the check is control characters
const forbiddenControls = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** A visible name (S09 policy, `private.is_visible_name`), normalized as stored. */
function visibleName(max: number) {
  return z
    .string()
    .max(4 * max, { error: "tooLong" satisfies RecipeFieldError })
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
              : "invalidCharacters") satisfies RecipeFieldError,
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

/** The comparison key of a tag: what the database folds (case, accents, compatibility forms). */
export function tagKey(tag: string): string {
  return tag
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const quantitySchema = z
  .strictObject({
    num: z.number().int(),
    den: z.number().int(),
    style: z.enum(quantityStyles),
  })
  .refine(
    (q) => isValidQuantity(q) && (q.style === "fraction" || 1000 % q.den === 0),
    "invalidQuantity",
  );

const unitSchema = z.custom<RecipeUnit>(isRecipeUnit, "invalid");

const minutesSchema = z.number().int().min(0).max(RECIPE_FIELD_LIMITS.maxMinutes);

/**
 * A recipe's content as the API takes it (a draft may be empty; the published minimum is checked
 * by the database, which answers `incomplete`). The same shape `public.get_recipe` returns.
 */
export const recipeContentSchema = z.strictObject({
  name: visibleName(RECIPE_FIELD_LIMITS.name).nullable(),
  servings: z
    .number()
    .int()
    .min(RECIPE_LIMITS.minServings)
    .max(RECIPE_LIMITS.maxServings)
    .nullable(),
  servingsLabel: visibleName(RECIPE_FIELD_LIMITS.servingsLabel).nullable(),
  prepMinutes: minutesSchema.nullable(),
  cookMinutes: minutesSchema.nullable(),
  notes: plainText(RECIPE_FIELD_LIMITS.notes).nullable(),
  tags: z
    .array(visibleName(RECIPE_FIELD_LIMITS.tag))
    .max(RECIPE_FIELD_LIMITS.tags)
    .refine((tags) => new Set(tags.map(tagKey)).size === tags.length, "duplicateTag"),
  ingredients: z
    .array(
      z.strictObject({
        name: visibleName(RECIPE_FIELD_LIMITS.ingredientName),
        quantity: quantitySchema.nullable(),
        unit: unitSchema.nullable(),
        note: visibleName(RECIPE_FIELD_LIMITS.ingredientNote).nullable(),
      }),
    )
    .max(RECIPE_FIELD_LIMITS.ingredients),
  steps: z.array(plainText(RECIPE_FIELD_LIMITS.step)).max(RECIPE_FIELD_LIMITS.steps),
  coverFileId: z.uuid().nullable(),
});
export type RecipeContent = z.output<typeof recipeContentSchema>;

const id = z.uuid();

/** `POST /api/v1/recipes`: a draft (publish false; homeId is its destination) or a recipe at once. */
export const createRecipeSchema = z.strictObject({
  id,
  homeId: id.nullable(),
  publish: z.boolean(),
  content: recipeContentSchema,
});

/** `PATCH /api/v1/recipes/:id`: a draft (with its destination) or, with the lock token, a recipe. */
export const updateRecipeSchema = z.strictObject({
  revision: z.number().int().min(1),
  content: recipeContentSchema,
  lockToken: id.nullable(),
  draftHomeId: id.nullable(),
});

export const publishRecipeSchema = z.strictObject({
  revision: z.number().int().min(1),
  requestId: id,
  homeId: id.nullable(),
});

/** A body-less change (DELETE): still same-origin JSON, so CSRF checks apply. */
export const emptyRecipeBody = z.strictObject({});

export const acquireLockSchema = z.strictObject({ token: id, takeOver: z.boolean() });
export const lockTokenSchema = z.strictObject({ token: id });
export const ratingSchema = z.strictObject({ stars: z.number().int().min(1).max(5) });

export const coverIntentSchema = z.strictObject({
  contentType: z.enum(coverTypes),
  size: z.number().int().min(1).max(RECIPE_FIELD_LIMITS.coverBytes),
  requestId: id,
  recipeId: id.nullable(),
  lockToken: id.nullable(),
});

/** The library's search parameters; anything unknown or malformed falls back to the default. */
export interface RecipeQuery {
  readonly q: string;
  readonly tags: readonly string[];
  readonly favorites: boolean;
  readonly sort: RecipeSort;
  readonly offset: number;
}

function single(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export function parseRecipeQuery(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): RecipeQuery {
  const q = (single(params.q) ?? "").slice(0, RECIPE_FIELD_LIMITS.query);
  const rawTags = params.tag;
  const list: readonly string[] = typeof rawTags === "string" ? [rawTags] : (rawTags ?? []);
  const tags = list.filter((tag) => tag.trim() !== "").slice(0, RECIPE_FIELD_LIMITS.tags);
  const sort = single(params.sort);
  const offset = Number(single(params.offset) ?? "0");
  return {
    q,
    tags,
    favorites: single(params.favorites) === "1",
    sort: (recipeSorts as readonly string[]).includes(sort ?? "")
      ? (sort as RecipeSort)
      : "name_asc",
    offset:
      Number.isInteger(offset) && offset >= 0 && offset <= RECIPE_FIELD_LIMITS.maxOffset
        ? offset
        : 0,
  };
}

/** The library's search parameters back as a query string (without the offset). */
export function recipeQueryString(query: Omit<RecipeQuery, "offset">, offset = 0): string {
  const params = new URLSearchParams();
  if (query.q.trim() !== "") params.set("q", query.q);
  for (const tag of query.tags) params.append("tag", tag);
  if (query.favorites) params.set("favorites", "1");
  if (query.sort !== "name_asc") params.set("sort", query.sort);
  if (offset > 0) params.set("offset", String(offset));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

// The editor -------------------------------------------------------------------------------------

/** One ingredient row as typed; blank rows are dropped when saving. */
export interface IngredientInput {
  name: string;
  quantity: string;
  unit: RecipeUnit | "";
  note: string;
}

/** The editor's values: every field as typed. */
export interface RecipeFormValues {
  name: string;
  servings: string;
  servingsLabel: string;
  prepMinutes: string;
  cookMinutes: string;
  notes: string;
  tags: string[];
  ingredients: IngredientInput[];
  steps: { text: string }[];
  coverFileId: string | null;
}

export function emptyIngredient(): IngredientInput {
  return { name: "", quantity: "", unit: "", note: "" };
}

export function emptyRecipeForm(): RecipeFormValues {
  return {
    name: "",
    servings: "",
    servingsLabel: "",
    prepMinutes: "",
    cookMinutes: "",
    notes: "",
    tags: [],
    ingredients: [emptyIngredient()],
    steps: [{ text: "" }],
    coverFileId: null,
  };
}

const blank = (value: string) => value.trim() === "";
const ingredientIsBlank = (row: IngredientInput) =>
  blank(row.name) && blank(row.quantity) && row.unit === "" && blank(row.note);

function wholeNumber(value: string, min: number, max: number): number | null | undefined {
  if (blank(value)) return null;
  if (!/^\d{1,6}$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return number >= min && number <= max ? number : undefined;
}

/**
 * The editor's values as content, or the fields that are wrong (`path` → error). `publishing` adds
 * the published minimum: a name and at least one ingredient or step.
 */
export function toRecipeContent(
  values: RecipeFormValues,
  publishing: boolean,
):
  | { readonly ok: true; readonly content: RecipeContent }
  | { readonly ok: false; readonly errors: Readonly<Record<string, RecipeFieldError>> } {
  const errors: Record<string, RecipeFieldError> = {};
  const ingredients = values.ingredients
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !ingredientIsBlank(row));
  const steps = values.steps
    .map((step, index) => ({ text: step.text, index }))
    .filter(({ text }) => !blank(text));
  const quantities = new Map<number, Quantity | null>();
  for (const { row, index } of ingredients) {
    if (blank(row.name)) errors[`ingredients.${String(index)}.name`] = "required";
    if (!blank(row.quantity)) {
      const quantity = parseQuantity(row.quantity);
      if (!quantity) errors[`ingredients.${String(index)}.quantity`] = "invalidQuantity";
      quantities.set(index, quantity);
    }
  }
  const servings = wholeNumber(
    values.servings,
    RECIPE_LIMITS.minServings,
    RECIPE_LIMITS.maxServings,
  );
  if (servings === undefined) errors.servings = "invalidNumber";
  const prepMinutes = wholeNumber(values.prepMinutes, 0, RECIPE_FIELD_LIMITS.maxMinutes);
  if (prepMinutes === undefined) errors.prepMinutes = "invalidNumber";
  const cookMinutes = wholeNumber(values.cookMinutes, 0, RECIPE_FIELD_LIMITS.maxMinutes);
  if (cookMinutes === undefined) errors.cookMinutes = "invalidNumber";
  if (publishing) {
    if (blank(values.name)) errors.name = "required";
    if (ingredients.length === 0 && steps.length === 0) errors.ingredients = "required";
  }

  const candidate = {
    name: blank(values.name) ? null : values.name,
    servings: servings ?? null,
    servingsLabel: blank(values.servingsLabel) ? null : values.servingsLabel,
    prepMinutes: prepMinutes ?? null,
    cookMinutes: cookMinutes ?? null,
    notes: blank(values.notes) ? null : values.notes,
    tags: values.tags,
    ingredients: ingredients.map(({ row, index }) => ({
      name: row.name,
      quantity: quantities.get(index) ?? null,
      unit: row.unit === "" ? null : row.unit,
      note: blank(row.note) ? null : row.note,
    })),
    steps: steps.map(({ text }) => text),
    coverFileId: values.coverFileId,
  };
  const parsed = recipeContentSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [field, position, part] = issue.path;
      const message = (issue.message as RecipeFieldError | undefined) ?? "invalid";
      const code: RecipeFieldError = [
        "required",
        "tooLong",
        "invalidCharacters",
        "invalidQuantity",
        "duplicateTag",
      ].includes(message)
        ? message
        : issue.code === "too_big"
          ? field === "tags" || field === "ingredients" || field === "steps"
            ? "tooMany"
            : "tooLong"
          : "invalid";
      if (field === "ingredients" && typeof position === "number") {
        const original = ingredients[position]?.index ?? position;
        errors[`ingredients.${String(original)}.${String(part ?? "name")}`] ??= code;
      } else if (field === "steps" && typeof position === "number") {
        errors[`steps.${String(steps[position]?.index ?? position)}.text`] ??= code;
      } else {
        errors[String(field ?? "root")] ??= code;
      }
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) {
    return { ok: false, errors: Object.keys(errors).length > 0 ? errors : { root: "invalid" } };
  }
  return { ok: true, content: parsed.data };
}
