import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getRecipe } from "@/recipes/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  pathId,
  readRecipeMutation,
  RECIPE_BODY_BYTES,
  requireReader,
} from "@/recipes/route-helpers";
import { emptyRecipeBody, updateRecipeSchema } from "@/recipes/schema";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

/**
 * One recipe or draft with everything its pages show (S24). Cooking mode reads it every minute to
 * notice a change. Not the person's to see (another person's draft, a Home they left) answers 404,
 * exactly like one that does not exist.
 */
export async function GET(_request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const recipe = await getRecipe(recipeId);
  if (recipe.status === "not-found") return failure(404, "not-found");
  if (recipe.status === "unavailable") return failure(500, "failed");
  return json(200, recipe.value);
}

/**
 * Saves a recipe's content (S24, latest-only). A draft needs only its revision (and keeps or
 * changes its intended destination); a published recipe also needs the editor's lock token, and
 * the database rechecks the lock, the person's rights and the revision in one transaction. Saving
 * a published recipe releases the lock.
 */
export async function PATCH(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, updateRecipeSchema, RECIPE_BODY_BYTES);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_recipe", {
    p_recipe_id: recipeId,
    p_expected_revision: change.revision,
    p_content: change.content,
    ...(change.lockToken ? { p_lock_token: change.lockToken } : {}),
    ...(change.draftHomeId ? { p_draft_home_id: change.draftHomeId } : {}),
  });
  if (error) return databaseFailure("recipes.update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "recipes.update_failed",
    row?.outcome,
    { id: recipeId, revision: row?.revision },
    row?.revision,
  );
}

/**
 * Moves a recipe (or discards a draft) to the trash for 7 days, with its cover. A recipe someone
 * else is editing right now answers `409 locked`.
 */
export async function DELETE(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, emptyRecipeBody);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_recipe", { p_recipe_id: recipeId });
  if (error) return databaseFailure("recipes.delete_failed", error);
  const row = data[0];
  return outcomeAnswer("recipes.delete_failed", row?.outcome, { id: recipeId });
}
