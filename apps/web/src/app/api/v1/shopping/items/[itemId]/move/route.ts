import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { moveSchema } from "@/shopping/schema";

interface ItemRouteContext {
  readonly params: Promise<{ readonly itemId: string }>;
}

/**
 * Moves an active item one place up or down within its group (editors). Relative, under the list's
 * lock, so concurrent reorders never overwrite each other with a stale order.
 */
export async function POST(request: Request, { params }: ItemRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, moveSchema);
  if (!input.ok) return input.response;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("move_shopping_item", {
    p_item_id: itemId,
    p_direction: input.data.direction,
  });
  if (error) return databaseFailure("shopping.move_item_failed", error);
  return outcomeAnswer("shopping.move_item_failed", data, { outcome: data });
}
