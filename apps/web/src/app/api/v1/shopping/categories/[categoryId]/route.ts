import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { revisionSchema, updateCategorySchema } from "@/shopping/schema";

interface CategoryRouteContext {
  readonly params: Promise<{ readonly categoryId: string }>;
}

/**
 * Renames a category (revision-checked; names stay distinct within the list) or moves it one place
 * up or down in the list's category order (relative, under the list's lock). Editors of the list.
 */
export async function PATCH(request: Request, { params }: CategoryRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, updateCategorySchema);
  if (!input.ok) return input.response;
  const categoryId = pathId((await params).categoryId);
  if (!categoryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  if ("direction" in input.data) {
    const { data, error } = await supabase.rpc("move_shopping_category", {
      p_id: categoryId,
      p_direction: input.data.direction,
    });
    if (error) return databaseFailure("shopping.move_category_failed", error);
    return outcomeAnswer("shopping.move_category_failed", data, { outcome: data });
  }
  const { data, error } = await supabase.rpc("rename_shopping_category", {
    p_id: categoryId,
    p_expected_revision: input.data.revision,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("shopping.rename_category_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "shopping.rename_category_failed",
    row?.outcome,
    { id: categoryId, revision: row?.revision ?? null },
    row?.revision,
  );
}

/**
 * Removes a category (revision-checked, after the page showed how many items it holds): its items
 * move to Uncategorized, keeping their order; recurring rules continue Uncategorized.
 */
export async function DELETE(
  request: Request,
  { params }: CategoryRouteContext,
): Promise<Response> {
  const input = await readShoppingMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const categoryId = pathId((await params).categoryId);
  if (!categoryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_shopping_category", {
    p_id: categoryId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("shopping.delete_category_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.delete_category_failed", row?.outcome, {
    id: categoryId,
    movedItems: row?.moved_items ?? 0,
  });
}
