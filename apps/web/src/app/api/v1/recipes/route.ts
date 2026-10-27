import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listRecipes } from "@/recipes/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readRecipeMutation,
  RECIPE_BODY_BYTES,
  requireReader,
} from "@/recipes/route-helpers";
import { createRecipeSchema, parseRecipeQuery } from "@/recipes/schema";

/**
 * One page of a context's published recipes (S24), for "Show more" after the first
 * server-rendered page: the same search, tags, favorites and sort as the page's search parameters,
 * 24 at a time, with the filtered total. Drafts never appear here.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z
    .uuid()
    .optional()
    .safeParse(params.get("homeId") ?? undefined);
  if (!homeId.success) return failure(400, "invalid");
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    if (key === "homeId") continue;
    const values = params.getAll(key);
    raw[key] = key === "tag" ? values : (values[0] ?? "");
  }
  const page = await listRecipes(homeId.data ?? null, parseRecipeQuery(raw));
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}

/**
 * Creates a recipe (S24): a private draft (`publish` false; `homeId` is only where it is meant to
 * go) or a recipe published at once into the Personal space or a Home the person belongs to. The
 * id comes from the client, so a retry answers the same recipe (`200`) instead of a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readRecipeMutation(request, createRecipeSchema, RECIPE_BODY_BYTES);
  if (!input.ok) return input.response;
  const recipe = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_recipe", {
    p_id: recipe.id,
    p_content: recipe.content,
    ...(recipe.homeId ? { p_home_id: recipe.homeId } : {}),
    p_publish: recipe.publish,
  });
  if (error) return databaseFailure("recipes.create_failed", error);
  const row = data[0];
  return outcomeAnswer("recipes.create_failed", row?.outcome, {
    id: recipe.id,
    revision: row?.revision,
    status: row?.status,
  });
}
