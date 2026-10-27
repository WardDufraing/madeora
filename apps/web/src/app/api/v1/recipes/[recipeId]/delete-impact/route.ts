import { getDeleteImpact } from "@/recipes/data";
import { failure, json, pathId, requireReader } from "@/recipes/route-helpers";

interface RecipeRouteContext {
  readonly params: Promise<{ readonly recipeId: string }>;
}

/**
 * What deleting a recipe would affect (S25, spec "impact-reviewed deletion of shared recipes"):
 * the Homes it is shared with, how many favorites it has, whether someone is editing it, and the
 * token the delete sends back so a changed recipe or share list is caught. Only for someone who
 * may delete it.
 */
export async function GET(_request: Request, { params }: RecipeRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const recipeId = pathId((await params).recipeId);
  if (!recipeId) return failure(404, "not-found");
  const impact = await getDeleteImpact(recipeId);
  if (impact.status === "not-found") return failure(404, "not-found");
  if (impact.status === "not-permitted") return failure(403, "not-permitted");
  if (impact.status === "unavailable") return failure(500, "failed");
  return json(200, impact.value);
}
