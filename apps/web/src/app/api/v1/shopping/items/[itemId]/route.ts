import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { updateItemSchema } from "@/shopping/schema";

interface ItemRouteContext {
  readonly params: Promise<{ readonly itemId: string }>;
}

/**
 * Edits an item's details or category (editors of an active list; revision-checked). Never changes
 * its completion. A new category puts it at the end of that group.
 */
export async function PATCH(request: Request, { params }: ItemRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, updateItemSchema);
  if (!input.ok) return input.response;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const item = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_shopping_item", {
    p_item_id: itemId,
    p_expected_revision: item.revision,
    p_name: item.name,
    // Omitted arguments are null (cleared). A canonical quantity (at most 3 decimals, ≤ 100,000)
    // is exact as a JSON number: it serializes back to the same digits, read as numeric.
    ...(item.quantity === null ? {} : { p_quantity: Number(item.quantity) }),
    ...(item.unit === null ? {} : { p_unit: item.unit }),
    ...(item.packaging === null ? {} : { p_packaging: item.packaging }),
    ...(item.notes === null ? {} : { p_notes: item.notes }),
    ...(item.categoryId === null ? {} : { p_category_id: item.categoryId }),
  });
  if (error) return databaseFailure("shopping.update_item_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "shopping.update_item_failed",
    row?.outcome,
    { id: itemId, revision: row?.revision ?? null },
    row?.revision,
  );
}

/** Moves an item to the trash (editors of an active list); restorable for 7 days. */
export async function DELETE(request: Request, { params }: ItemRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_shopping_item", { p_item_id: itemId });
  if (error) return databaseFailure("shopping.delete_item_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.delete_item_failed", row?.outcome, {
    id: itemId,
    entryId: row?.entry_id ?? null,
  });
}
