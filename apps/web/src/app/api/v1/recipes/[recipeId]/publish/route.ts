import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readRecipeMutation,
} from "@/recipes/route-helpers";
import { publishRecipeSchema } from "@/recipes/schema";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

/**
 * Publishes the person's own draft to the Personal space (`homeId` null) or a Home they belong to
 * now (S24). The database rechecks the membership, the published minimum and the content, and
 * moves the cover to the destination's storage (`storage_full` changes nothing). A repeated or
 * doubled publish answers `already_published` (200), never a second recipe.
 */
export async function POST(request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const input = await readRecipeMutation(request, publishRecipeSchema);
  if (!input.ok) return input.response;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const publish = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("publish_recipe", {
    p_recipe_id: recipeId,
    p_expected_revision: publish.revision,
    p_request_id: publish.requestId,
    ...(publish.homeId ? { p_home_id: publish.homeId } : {}),
  });
  if (error) return databaseFailure("recipes.publish_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "recipes.publish_failed",
    row?.outcome,
    { id: recipeId, revision: row?.revision, homeId: publish.homeId },
    row?.revision,
  );
}
