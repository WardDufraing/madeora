import "server-only";

import { z } from "zod";

import { mealCadences, mealStandardSlots } from "@madeora/domain/meals";
import { recipeUnits } from "@madeora/domain/recipes";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listShoppingLists } from "@/shopping/data";
import { personalToday } from "@/tasks/data";

import type {
  MealCopyPreview,
  MealPlan,
  MealRecipeOption,
  MealSeriesPreview,
  MealSlotImpact,
  MealTransferPreview,
} from "./api";
import { logMeals } from "./log";

/**
 * Server reads of the meal planner (S27), always with the signed-in person's own Supabase session:
 * the database answers only what they may see now, so a Home they left is simply not there and a
 * recipe they may not see from the planner's context comes back without its details. Nothing here
 * is cached across requests (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  /** Not a Home the person belongs to (or none such), or not theirs to see. */
  | { readonly status: "not-found" }
  | { readonly status: "not-permitted" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  if (error.code === "22023" || error.code === "22P02") return { status: "invalid" };
  logMeals(event, error.code);
  return { status: "unavailable" };
}

const homeArg = (homeId: string | null) => (homeId ? { p_home_id: homeId } : {});

/** "Today" for a context: the Home's own (the database knows it), or the person's for Personal. */
export async function todayArg(homeId: string | null): Promise<{ p_today?: string }> {
  return homeId ? {} : { p_today: await personalToday() };
}

const recipeRef = z
  .object({ id: z.uuid(), name: z.string(), servings: z.number().int().nullable() })
  .nullable();
const content = {
  date: z.iso.date(),
  slotId: z.uuid(),
  type: z.enum(["recipe", "custom"]),
  recipe: recipeRef,
  title: z.string().nullable(),
  notes: z.string().nullable(),
  servings: z.number().int().nullable(),
};
export const entrySchema = z.object({
  kind: z.literal("entry"),
  id: z.uuid(),
  revision: z.number().int(),
  origin: z
    .object({ recurrenceId: z.uuid(), date: z.iso.date(), seriesId: z.uuid().nullable() })
    .nullable(),
  ...content,
});
export const occurrenceSchema = z.object({
  kind: z.literal("occurrence"),
  recurrenceId: z.uuid(),
  seriesId: z.uuid(),
  cadence: z.enum(mealCadences),
  seriesRevision: z.number().int(),
  ...content,
});
export const plannedSchema = z.discriminatedUnion("kind", [entrySchema, occurrenceSchema]);
export const occupiedSchema = z.object({
  occupants: z.array(plannedSchema),
  replaceKey: z.string(),
});
export const collisionSchema = occupiedSchema.extend({ date: z.iso.date() });

const planSchema = z.object({
  access: z.enum(["manage", "edit", "view"]),
  memberAccess: z.enum(["edit", "view"]),
  settingsRevision: z.number().int(),
  today: z.iso.date(),
  from: z.iso.date(),
  to: z.iso.date(),
  slots: z.array(
    z.object({
      id: z.uuid(),
      standardKey: z.enum(mealStandardSlots).nullable(),
      name: z.string().nullable(),
      position: z.number().int(),
      enabled: z.boolean(),
      revision: z.number().int(),
    }),
  ),
  entries: z.array(entrySchema),
  occurrences: z.array(occurrenceSchema),
  series: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(["active", "paused"]),
      revision: z.number().int(),
      endOn: z.iso.date().nullable(),
      recurrenceId: z.uuid(),
      slotId: z.uuid(),
      slotEnabled: z.boolean(),
      type: z.enum(["recipe", "custom"]),
      recipe: recipeRef,
      title: z.string().nullable(),
      notes: z.string().nullable(),
      servings: z.number().int().nullable(),
      cadence: z.enum(mealCadences),
      weekdays: z.array(z.number().int()).nullable(),
      startOn: z.iso.date(),
      segmentEndOn: z.iso.date().nullable(),
    }),
  ),
  token: z.string(),
});

/**
 * The plan of a context between two dates (none: today), creating its standard slots on first
 * open. Not-found for a Home the person does not belong to; invalid for a malformed range.
 */
export async function readMealPlan(
  homeId: string | null,
  from: string | null,
  to: string | null,
): Promise<Read<MealPlan>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_meal_plan", {
    ...homeArg(homeId),
    ...(from ? { p_from: from } : {}),
    ...(to ? { p_to: to } : {}),
    ...(await todayArg(homeId)),
  });
  if (error) return failed("meals.plan_failed", error);
  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    logMeals("meals.plan_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const impactSchema = z.object({
  futureMeals: z.number().int(),
  pastMeals: z.number().int(),
  series: z.number().int(),
  token: z.string(),
});

/** What disabling a slot would affect. */
export async function readSlotImpact(slotId: string): Promise<Read<MealSlotImpact>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("meal_slot_impact", { p_slot_id: slotId });
  if (error) return failed("meals.slot_impact_failed", error);
  const row = data[0];
  if (row?.outcome !== "ok") return { status: "not-found" };
  const parsed = impactSchema.safeParse(row.impact);
  if (!parsed.success) {
    logMeals("meals.slot_impact_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const copyPreviewSchema = z.object({
  rows: z.array(
    occupiedSchema.extend({
      key: z.string(),
      sourceDate: z.iso.date(),
      date: z.iso.date(),
      slotId: z.uuid(),
      type: z.enum(["recipe", "custom"]),
      recipe: recipeRef,
      title: z.string().nullable(),
      notes: z.string().nullable(),
      servings: z.number().int().nullable(),
      repeating: z.boolean(),
      status: z.enum(["ok", "unavailable", "slot_disabled"]),
    }),
  ),
  token: z.string(),
});

/** What copying one week to another would make. */
export async function previewMealCopy(
  homeId: string | null,
  source: string,
  destination: string,
): Promise<Read<MealCopyPreview>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_meal_copy", {
    ...homeArg(homeId),
    p_source: source,
    p_destination: destination,
  });
  if (error) return failed("meals.copy_preview_failed", error);
  const row = data[0];
  if (row?.outcome === "not_permitted") return { status: "not-permitted" };
  const parsed = copyPreviewSchema.safeParse(row?.preview);
  if (!parsed.success) {
    logMeals("meals.copy_preview_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const transferMealsSchema = z.object({
  meals: z.array(
    z.object({
      key: z.string(),
      date: z.iso.date(),
      slotId: z.uuid(),
      status: z.enum(["included", "custom", "unavailable"]),
      title: z.string().nullable(),
      servings: z.number().int().nullable(),
      recipe: z
        .object({
          id: z.uuid(),
          name: z.string(),
          servings: z.number().int().nullable(),
          ingredients: z.array(
            z.object({
              position: z.number().int(),
              name: z.string(),
              quantityNum: z.number().int().nullable(),
              quantityDen: z.number().int().nullable(),
              unit: z.enum(recipeUnits).nullable(),
              note: z.string().nullable(),
            }),
          ),
        })
        .nullable(),
    }),
  ),
  token: z.string(),
});

/**
 * The meals of a date range for an ingredient transfer, with the active lists of the same context
 * the person may add to.
 */
export async function previewMealTransfer(
  homeId: string | null,
  from: string,
  to: string,
): Promise<Read<MealTransferPreview>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_meal_ingredients", {
    ...homeArg(homeId),
    p_from: from,
    p_to: to,
  });
  if (error) return failed("meals.transfer_preview_failed", error);
  const row = data[0];
  if (row?.outcome === "not_permitted") return { status: "not-permitted" };
  const parsed = transferMealsSchema.safeParse(row?.preview);
  if (!parsed.success) {
    logMeals("meals.transfer_preview_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  const lists = await listShoppingLists(homeId, false);
  if (lists.status !== "ok") return lists;
  return {
    status: "ok",
    value: {
      ...parsed.data,
      lists: lists.value
        .filter((list) => list.access === "manage" || list.access === "edit")
        .map((list) => ({ id: list.id, name: list.name, position: list.position })),
    },
  };
}

/** Recipes that may be planned from the context (published and visible from it), by name. */
export async function listMealRecipes(
  homeId: string | null,
  query: string | null,
): Promise<Read<readonly MealRecipeOption[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_meal_recipes", {
    ...homeArg(homeId),
    ...(query ? { p_query: query } : {}),
  });
  if (error) return failed("meals.recipes_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({ id: row.id, name: row.name, servings: row.servings })),
  };
}

const seriesPreviewSchema = z.object({
  nextDates: z.array(z.iso.date()),
  collisions: z.array(collisionSchema),
  token: z.string(),
});

/** The schedule a series preview checks: a new series, or an existing one from a date. */
export interface SeriesSchedule {
  readonly homeId: string | null;
  readonly seriesId: string | null;
  readonly slotId: string;
  readonly cadence: string;
  readonly weekdays: readonly number[] | null;
  readonly startOn: string;
  readonly endOn: string | null;
}

/**
 * The next dates of a repeating meal and its collisions over the coming year, with the token a
 * create, edit or resume must send back. `outcome` refusals (a closed slot, a past date) are kept.
 */
export async function previewMealSeries(
  schedule: SeriesSchedule,
): Promise<Read<{ readonly outcome: string; readonly preview: MealSeriesPreview | null }>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_meal_series", {
    ...homeArg(schedule.homeId),
    ...(schedule.seriesId ? { p_series_id: schedule.seriesId } : {}),
    ...(schedule.endOn ? { p_end_on: schedule.endOn } : {}),
    p_slot_id: schedule.slotId,
    p_cadence: schedule.cadence,
    p_weekdays: [...(schedule.weekdays ?? [])],
    p_start_on: schedule.startOn,
    ...(await todayArg(schedule.homeId)),
  });
  if (error) return failed("meals.series_preview_failed", error);
  const row = data[0];
  if (row?.outcome !== "ok")
    return { status: "ok", value: { outcome: row?.outcome ?? "failed", preview: null } };
  const parsed = seriesPreviewSchema.safeParse(row.preview);
  if (!parsed.success) {
    logMeals("meals.series_preview_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: { outcome: "ok", preview: parsed.data } };
}
