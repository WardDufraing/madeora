import { z } from "zod";

import { readRecipeWidget } from "@/recipes/data";
import { failure, json, requireReader } from "@/recipes/route-helpers";
import { RECIPE_FIELD_LIMITS, recipeWidgetModes } from "@/recipes/schema";

const widgetQuerySchema = z.strictObject({
  homeId: z.uuid().optional(),
  mode: z.enum(recipeWidgetModes),
  limit: z.coerce.number().int().min(1).max(RECIPE_FIELD_LIMITS.widget),
  seed: z.string().max(64).optional(),
});

/**
 * A Recipes widget's cards (S24): the person's favorites, recently added, highest rated or a
 * random pick (a new `seed` shows another) from one context, with the person's own session.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const query = widgetQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!query.success) return failure(400, "invalid");
  const { homeId, mode, limit, seed } = query.data;
  const cards = await readRecipeWidget(homeId ?? null, mode, limit, seed ?? null);
  if (cards.status === "not-found") return failure(404, "not-found");
  if (cards.status === "unavailable") return failure(500, "failed");
  return json(200, cards.value);
}
