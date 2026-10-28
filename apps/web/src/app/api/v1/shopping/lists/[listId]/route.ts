import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getShoppingList } from "@/shopping/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
  requireReader,
} from "@/shopping/route-helpers";
import { revisionSchema, updateListSchema } from "@/shopping/schema";

interface ListRouteContext {
  readonly params: Promise<{ readonly listId: string }>;
}

/** One list with its categories, items, recurring rules and move/copy destinations (S26). */
export async function GET(request: Request, { params }: ListRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const homeId = pathId(new URL(request.url).searchParams.get("homeId") ?? "");
  const list = await getShoppingList(listId, homeId);
  if (list.status === "not-found") return failure(404, "not-found");
  if (list.status === "unavailable") return failure(500, "failed");
  return json(200, list.value);
}

/**
 * Renames a list, sets what other members may do with it, and archives or restores it (its
 * managers; revision-checked, so a stale form answers `409 conflict` with the current revision).
 */
export async function PATCH(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, updateListSchema);
  if (!input.ok) return input.response;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_shopping_list", {
    p_list_id: listId,
    p_expected_revision: input.data.revision,
    p_name: input.data.name,
    p_member_access: input.data.memberAccess,
    p_archived: input.data.archived,
  });
  if (error) return databaseFailure("shopping.update_list_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "shopping.update_list_failed",
    row?.outcome,
    { id: listId, revision: row?.revision ?? null },
    row?.revision,
  );
}

/** Moves a list with its items to the trash as one entry (its managers; revision-checked). */
export async function DELETE(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const listId = pathId((await params).listId);
  if (!listId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_shopping_list", {
    p_list_id: listId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("shopping.delete_list_failed", error);
  const row = data[0];
  return outcomeAnswer("shopping.delete_list_failed", row?.outcome, {
    id: listId,
    entryId: row?.entry_id ?? null,
  });
}
