import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listRecipeShares } from "@/recipes/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  pathId,
  readRecipeMutation,
  requireReader,
} from "@/recipes/route-helpers";
import { shareRecipeSchema, unshareRecipeSchema } from "@/recipes/schema";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

/**
 * Where a recipe is shared (active or paused since it was deleted) and the Homes it could still be
 * shared with (S25). Only a recipe manager of its origin gets any rows; anyone else gets an empty
 * list, never a hint of where it is shared.
 */
export async function GET(_request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const shares = await listRecipeShares(recipeId);
  if (shares.status === "not-found") return failure(404, "not-found");
  if (shares.status === "unavailable") return failure(500, "failed");
  return json(200, { shares: shares.value });
}

/**
 * Shares a published recipe with a Home the person belongs to, changes whether that Home's recipe
 * managers may edit it, or reinstates a paused share. A recipe manager of its origin only. One
 * canonical recipe: nothing is copied. Set-to-state, so a repeat answers `unchanged`.
 */
export async function PUT(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, shareRecipeSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("share_recipe", {
    p_recipe_id: recipeId,
    p_home_id: input.data.homeId,
    p_can_edit: input.data.canEdit,
  });
  if (error) return databaseFailure("recipes.share_failed", error);
  return outcomeAnswer("recipes.share_failed", data, { outcome: data });
}

/**
 * Removes a recipe's share with one Home: a recipe manager of its origin, or of that Home ("Remove
 * from this Home"). The recipe and its other shares stay.
 */
export async function DELETE(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, unshareRecipeSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("unshare_recipe", {
    p_recipe_id: recipeId,
    p_home_id: input.data.homeId,
  });
  if (error) return databaseFailure("recipes.unshare_failed", error);
  return outcomeAnswer("recipes.unshare_failed", data, { outcome: data });
}
