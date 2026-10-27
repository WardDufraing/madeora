import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { RatingAnswer } from "@/recipes/api";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  ratingAverage,
  readRecipeMutation,
} from "@/recipes/route-helpers";
import { emptyRecipeBody, ratingSchema } from "@/recipes/schema";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

async function setRating(recipeId: string, stars: number | null): Promise<Response> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_recipe_rating", {
    p_recipe_id: recipeId,
    ...(stars === null ? {} : { p_stars: stars }),
  });
  if (error) return databaseFailure("recipes.rating_failed", error);
  const row = data[0];
  const body: RatingAnswer = {
    mine: row ? nullable(row.mine) : null,
    average: ratingAverage(row?.average),
    count: row?.rating_count ?? 0,
  };
  return outcomeAnswer("recipes.rating_failed", row?.outcome, body);
}

/**
 * Sets the person's 1–5 star rating of a published recipe they may see (S24). Answers their
 * rating and the average and count over the recipe's current members, never anyone's own rating.
 */
export async function PUT(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, ratingSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  return setRating(recipeId, input.data.stars);
}

/** Clears the person's rating. */
export async function DELETE(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, emptyRecipeBody);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  return setRating(recipeId, null);
}
