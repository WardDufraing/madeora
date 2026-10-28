import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { createCategorySchema } from "@/shopping/schema";

interface ListRouteContext {
  readonly params: Promise<{ readonly listId: string }>;
}

/**
 * Adds a category at the end of the list's category order (its editors). Names are distinct
 * within the list, ignoring case and accents (`409 duplicate-name`). A retry answers `200`.
 */
export async function POST(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, createCategorySchema);
  if (!input.ok) return input.response;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_shopping_category", {
    p_id: input.data.id,
    p_list_id: listId,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("shopping.create_category_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.create_category_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision ?? null,
  });
}
