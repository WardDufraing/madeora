import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { transferSchema } from "@/shopping/schema";

interface ItemRouteContext {
  readonly params: Promise<{ readonly itemId: string }>;
}

/**
 * Moves or copies an item to another active list of the same context (editors of both). Rechecks
 * both lists, the item's revision, the destination category and duplicates at confirmation. Moves
 * keep the item's id; a copy uses the client's id, so a retry answers the same copy. Personal ↔
 * Home and cross-Home transfers answer `403 not-permitted`.
 */
export async function POST(request: Request, { params }: ItemRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, transferSchema);
  if (!input.ok) return input.response;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("transfer_shopping_item", {
    p_item_id: itemId,
    p_mode: body.mode,
    p_destination_list_id: body.destinationListId,
    p_expected_revision: body.revision,
    ...(body.categoryId ? { p_category_id: body.categoryId } : {}),
    p_keep_completed: body.keepCompleted,
    p_allow_duplicate: body.allowDuplicate,
    ...(body.copyId ? { p_copy_id: body.copyId } : {}),
  });
  if (error) return databaseFailure("shopping.transfer_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.transfer_failed", row?.outcome, {
    outcome: row?.outcome ?? null,
    itemId: row?.item_id ?? null,
  });
}
