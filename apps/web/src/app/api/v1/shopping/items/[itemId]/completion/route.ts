import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { completionSchema } from "@/shopping/schema";

interface ItemRouteContext {
  readonly params: Promise<{ readonly itemId: string }>;
}

/**
 * Checks or unchecks an item (set-to-state; anyone who may check off). Checking a completed item
 * answers `unchanged` with who completed it; unchecking sends the completion the person saw, and a
 * newer one answers `409 conflict` instead of being overwritten.
 */
export async function PUT(request: Request, { params }: ItemRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, completionSchema);
  if (!input.ok) return input.response;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_shopping_item_completed", {
    p_item_id: itemId,
    p_completed: input.data.completed,
    ...(input.data.seenCompletedAt ? { p_seen_completed_at: input.data.seenCompletedAt } : {}),
  });
  if (error) return databaseFailure("shopping.completion_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.completion_failed", row?.outcome, {
    outcome: row?.outcome ?? null,
    completedAt: row?.completed_at ?? null,
    completedBy: row?.completed_by ?? null,
  });
}
