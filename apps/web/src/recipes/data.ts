import "server-only";

import { z } from "zod";

import { isRecipeUnit, quantityStyles } from "@madeora/domain/recipes";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import type {
  RecipeDetail,
  RecipeDraftSummary,
  RecipePage,
  RecipeTag,
  RecipeWidgetData,
} from "./api";
import { logRecipes } from "./log";
import { ratingAverage } from "./route-helpers";
import { RECIPE_FIELD_LIMITS, type RecipeQuery, type RecipeWidgetMode } from "./schema";

/**
 * Server reads of recipes (S24), always with the signed-in person's own Supabase session: the
 * database answers only what they may see now, so a Home they left, another person's draft or a
 * recipe that is not theirs is simply not there. Nothing here is cached across requests
 * (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  /** Not a Home the person belongs to (or none such), or not theirs to see. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/** Widens a value to include null, because the generated database types do not. */
function nullable<T>(value: T): T | null {
  return value;
}

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  logRecipes(event, error.code);
  return { status: "unavailable" };
}

const homeArg = (homeId: string | null) => (homeId ? { p_home_id: homeId } : {});

export interface RecipeContextInfo {
  readonly canCreate: boolean;
  /** Whether the viewer may edit and delete every recipe of the context (Owner, delegated). */
  readonly canManage: boolean;
}

export async function getRecipeContext(homeId: string | null): Promise<Read<RecipeContextInfo>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_recipe_context", homeArg(homeId));
  if (error) return failed("recipes.context_failed", error);
  const row = data[0];
  if (!row) return { status: "not-found" };
  return { status: "ok", value: { canCreate: row.can_create, canManage: row.can_manage } };
}

/** One page of a context's published recipes for the library, with the filtered total. */
export async function listRecipes(
  homeId: string | null,
  query: RecipeQuery,
): Promise<Read<RecipePage>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_recipes", {
    ...homeArg(homeId),
    ...(query.q.trim() !== "" ? { p_query: query.q } : {}),
    ...(query.tags.length > 0 ? { p_tags: [...query.tags] } : {}),
    p_favorites: query.favorites,
    p_sort: query.sort,
    p_limit: RECIPE_FIELD_LIMITS.page,
    p_offset: query.offset,
  });
  if (error) return failed("recipes.list_failed", error);
  return {
    status: "ok",
    value: {
      total: data[0]?.total_count ?? 0,
      recipes: data.map((row) => ({
        id: row.id,
        name: row.name,
        coverFileId: nullable(row.cover_file_id),
        tags: row.tags,
        servings: nullable(row.servings),
        prepMinutes: nullable(row.prep_minutes),
        cookMinutes: nullable(row.cook_minutes),
        matchedIngredient: nullable(row.matched_ingredient),
        favorite: row.favorite,
        myRating: nullable(row.my_rating),
        ratingAverage: ratingAverage(row.rating_average),
        ratingCount: row.rating_count,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
        revision: row.revision,
      })),
    },
  };
}

/** The context's tags (as last written) with how many recipes carry each, for the filter. */
export async function listRecipeTags(homeId: string | null): Promise<Read<readonly RecipeTag[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_recipe_tags", homeArg(homeId));
  if (error) return failed("recipes.tags_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({ tag: row.tag, count: row.recipe_count })),
  };
}

/** The signed-in person's own drafts, most recently edited first. */
export async function listMyDrafts(): Promise<Read<readonly RecipeDraftSummary[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_recipe_drafts");
  if (error) return failed("recipes.drafts_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      name: nullable(row.name),
      destinationHomeId: nullable(row.destination_home_id),
      destinationHomeName: nullable(row.destination_home_name),
      destinationLost: row.destination_lost,
      coverFileId: nullable(row.cover_file_id),
      updatedAt: row.updated_at,
      revision: row.revision,
    })),
  };
}

const person = z.object({ me: z.boolean(), member: z.uuid().nullable() });

const detailSchema = z.object({
  id: z.uuid(),
  status: z.enum(["draft", "published"]),
  homeId: z.uuid().nullable(),
  draftHomeId: z.uuid().nullable(),
  destinationLost: z.boolean(),
  name: z.string().nullable(),
  servings: z.number().int().nullable(),
  servingsLabel: z.string().nullable(),
  prepMinutes: z.number().int().nullable(),
  cookMinutes: z.number().int().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  coverFileId: z.uuid().nullable(),
  ingredients: z.array(
    z.object({
      name: z.string(),
      quantity: z
        .object({ num: z.number().int(), den: z.number().int(), style: z.enum(quantityStyles) })
        .nullable(),
      unit: z.string().refine(isRecipeUnit).nullable(),
      note: z.string().nullable(),
    }),
  ),
  steps: z.array(z.string()),
  revision: z.number().int(),
  createdAt: z.string(),
  createdBy: person,
  updatedAt: z.string(),
  updatedBy: person,
  publishedAt: z.string().nullable(),
  favorite: z.boolean(),
  rating: z.object({
    mine: z.number().int().nullable(),
    average: z.union([z.number(), z.string()]).nullable().transform(ratingAverage),
    count: z.number().int(),
  }),
  lock: z
    .object({ mine: z.boolean(), member: z.uuid().nullable(), expiresAt: z.string() })
    .nullable(),
  can: z.object({
    edit: z.boolean(),
    delete: z.boolean(),
    rate: z.boolean(),
    favorite: z.boolean(),
    publish: z.boolean(),
  }),
});

/** One recipe or draft, or not-found when it is missing, deleted or not the person's to see. */
export async function getRecipe(recipeId: string): Promise<Read<RecipeDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_recipe", { p_recipe_id: recipeId });
  if (error) {
    if (error.code === "22023" || error.code === "22P02") return { status: "not-found" };
    return failed("recipes.get_failed", error);
  }
  if (data === null) return { status: "not-found" };
  const parsed = detailSchema.safeParse(data);
  if (!parsed.success) {
    logRecipes("recipes.get_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

/** What a Recipes widget shows (S24): its cards and how many the mode could show in all. */
export async function readRecipeWidget(
  homeId: string | null,
  mode: RecipeWidgetMode,
  limit: number,
  seed: string | null,
): Promise<Read<RecipeWidgetData>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("recipe_widget", {
    ...homeArg(homeId),
    p_mode: mode,
    p_limit: limit,
    ...(seed ? { p_seed: seed } : {}),
  });
  if (error) return failed("recipes.widget_failed", error);
  return {
    status: "ok",
    value: {
      available: data[0]?.available ?? 0,
      cards: data.map((row) => ({
        id: row.id,
        name: row.name,
        coverFileId: nullable(row.cover_file_id),
        ratingAverage: ratingAverage(row.rating_average),
        ratingCount: row.rating_count,
      })),
    },
  };
}
