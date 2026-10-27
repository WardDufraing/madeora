import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { RecipeImportPreview } from "@/recipes/api";
import { findDuplicates, getRecipeContext } from "@/recipes/data";
import { extractRecipe } from "@/recipes/import/extract";
import { fetchRecipePage } from "@/recipes/import/fetch";
import { logRecipes } from "@/recipes/log";
import { databaseFailure, failure, json, readRecipeMutation } from "@/recipes/route-helpers";
import { importRecipeSchema } from "@/recipes/schema";

// The page is fetched with Node's own network stack (address checks, pinned connections).
export const runtime = "nodejs";

/**
 * Reads a recipe from a public web page for review (S25, spec "recipe URL import", ARCH §38). The
 * destination is checked first (a Home the person belongs to, or their Personal space), then one of
 * their hourly import slots is taken, then the page is fetched from the server with SSRF protection
 * and its schema.org Recipe read into an editable preview, with likely duplicates in the
 * destination. Nothing is stored: the person saves through the ordinary editor, after review.
 * Failures say why (`import-failed` with a reason) so the page can offer manual entry instead.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readRecipeMutation(request, importRecipeSchema);
  if (!input.ok) return input.response;
  const { url, homeId } = input.data;

  const context = await getRecipeContext(homeId);
  if (context.status === "not-found") return failure(404, "not-found");
  if (context.status !== "ok") return failure(500, "failed");
  if (!context.value.canCreate) return failure(403, "not-permitted");

  const supabase = await createSupabaseServerClient();
  const { data: slot, error } = await supabase.rpc("begin_recipe_import");
  if (error) return databaseFailure("recipes.import_slot_failed", error);
  if (slot === "rate_limited") return failure(429, "rate-limited");

  const page = await fetchRecipePage(url);
  if (!page.ok) {
    // The reason only, never the URL: it may say something about the person.
    logRecipes("recipes.import_fetch_refused", page.reason);
    return failure(422, "import-failed", { reason: page.reason });
  }
  const extraction = extractRecipe(page.body, page.url);
  if (!extraction.ok) return failure(422, "import-failed", { reason: "no_recipe" });

  const duplicates = await findDuplicates(
    homeId,
    extraction.preview.name,
    extraction.preview.source.url,
  );
  const preview: RecipeImportPreview = {
    ...extraction.preview,
    duplicates: duplicates.status === "ok" ? duplicates.value : [],
  };
  return json(200, preview);
}
