import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { ShoppingAddOutcome, ShoppingAddResult } from "@/shopping/api";
import {
  ADD_BODY_BYTES,
  databaseFailure,
  failure,
  json,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { addItemsSchema } from "@/shopping/schema";

interface ListRouteContext {
  readonly params: Promise<{ readonly listId: string }>;
}

const outcomes: readonly ShoppingAddOutcome[] = [
  "created",
  "exists",
  "id_taken",
  "invalid",
  "duplicate",
  "limit_reached",
  "not_found",
  "not_permitted",
];

/**
 * Adds one or several items (quick add, Add several; editors of an active list). Each row carries
 * its own client id, so a retry after a partial failure never adds a row twice, and the answer is
 * per row. A row whose name an active item already has answers `duplicate` unless it says
 * `allowDuplicate`; nothing is merged or summed.
 */
export async function POST(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, addItemsSchema, ADD_BODY_BYTES);
  if (!input.ok) return input.response;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_shopping_items", {
    p_list_id: listId,
    p_items: input.data.items,
  });
  if (error) return databaseFailure("shopping.add_items_failed", error);
  const results: ShoppingAddResult[] = data.map((row) => ({
    id: row.id,
    outcome: outcomes.find((outcome) => outcome === row.outcome) ?? "invalid",
  }));
  // The whole request was refused: answered as such, like any other change.
  if (results.every((result) => result.outcome === "not_found")) {
    return failure(404, "not-found");
  }
  if (results.every((result) => result.outcome === "not_permitted")) {
    return failure(403, "not-permitted");
  }
  return json(200, { results });
}
