import { listMealRecipes } from "@/meals/data";
import { readAnswer, readMealQuery } from "@/meals/route-helpers";
import { recipesQuerySchema } from "@/meals/schema";

/** Recipes that may be planned from the context: published and visible from it, by name. */
export async function GET(request: Request): Promise<Response> {
  const query = await readMealQuery(request, recipesQuerySchema);
  if (!query.ok) return query.response;
  const q = query.data.q?.trim() ?? "";
  return readAnswer(
    await listMealRecipes(query.data.homeId ?? null, q === "" ? null : q),
    "recipes",
  );
}
