import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readRecipeMutation,
} from "@/recipes/route-helpers";
import { emptyRecipeBody } from "@/recipes/schema";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

async function setFavorite(request: Request, context: RecipeRouteContext, favorite: boolean) {
  const input = await readRecipeMutation(request, emptyRecipeBody);
  if (!input.ok) return input.response;
  const recipeId = pathId((await context.params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_recipe_favorite", {
    p_recipe_id: recipeId,
    p_favorite: favorite,
  });
  if (error) return databaseFailure("recipes.favorite_failed", error);
  return outcomeAnswer("recipes.favorite_failed", data, { favorite });
}

/**
 * Marks a published recipe as one of the person's favorites in its context (S24), or unmarks it.
 * Set-to-state: a repeat or a double click changes nothing. A favorite never grants access.
 */
export function PUT(request: Request, context: RecipeRouteContext): Promise<Response> {
  return setFavorite(request, context, true);
}

export function DELETE(request: Request, context: RecipeRouteContext): Promise<Response> {
  return setFavorite(request, context, false);
}
