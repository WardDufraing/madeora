import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  CLEAR_BODY_BYTES,
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { clearCompletedSchema } from "@/shopping/schema";

interface ListRouteContext {
  readonly params: Promise<{ readonly listId: string }>;
}

/**
 * Clears the completed items the person saw (their ids): they go to the trash together as one
 * entry. Items reopened or gone meanwhile are left alone and counted as skipped.
 */
export async function POST(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, clearCompletedSchema, CLEAR_BODY_BYTES);
  if (!input.ok) return input.response;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("clear_completed_shopping_items", {
    p_list_id: listId,
    p_item_ids: input.data.itemIds,
  });
  if (error) return databaseFailure("shopping.clear_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.clear_failed", row?.outcome, {
    outcome: row?.outcome ?? null,
    cleared: row?.cleared ?? 0,
    skipped: row?.skipped ?? 0,
    entryId: row?.entry_id ?? null,
  });
}
