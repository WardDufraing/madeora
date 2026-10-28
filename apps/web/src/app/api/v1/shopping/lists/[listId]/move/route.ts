import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { moveSchema } from "@/shopping/schema";

interface ListRouteContext {
  readonly params: Promise<{ readonly listId: string }>;
}

/**
 * Moves a list one place up or down in its context's order (shopping managers). Relative, applied
 * under the context's lock, so two people reordering at once never overwrite each other.
 */
export async function POST(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, moveSchema);
  if (!input.ok) return input.response;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("move_shopping_list", {
    p_list_id: listId,
    p_direction: input.data.direction,
  });
  if (error) return databaseFailure("shopping.move_list_failed", error);
  return outcomeAnswer("shopping.move_list_failed", data, { outcome: data });
}
