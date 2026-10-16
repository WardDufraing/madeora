import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import { logTrash } from "./route-helpers";
import type { TrashEntry } from "./api";
import { isTrashItemType, isTrashModule, type ListQuery } from "./schema";

export type TrashListResult =
  | { readonly status: "ok"; readonly entries: readonly TrashEntry[] }
  /** Not a Home the person belongs to (or none such), or an unconfirmed session. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * The signed-in person's trash for one scope with their own session: the database returns only
 * what they may see now (`public.list_trash`), so a Home they left or an entry that is not theirs
 * to see simply is not there.
 */
export async function listTrash(query: ListQuery): Promise<TrashListResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_trash", {
    ...(query.homeId ? { p_home_id: query.homeId } : {}),
    ...(query.module ? { p_module: query.module } : {}),
    ...(query.itemType ? { p_item_type: query.itemType } : {}),
    ...(query.deletedFrom ? { p_deleted_from: query.deletedFrom } : {}),
    ...(query.deletedTo ? { p_deleted_to: query.deletedTo } : {}),
  });
  if (error) {
    if (error.code === "42501") return { status: "not-found" };
    logTrash("trash.list_failed", error.code);
    return { status: "unavailable" };
  }
  const entries: TrashEntry[] = [];
  for (const row of data) {
    // A module this code does not know yet is skipped rather than shown wrongly.
    if (!isTrashModule(row.module) || !isTrashItemType(row.item_type)) continue;
    entries.push({
      id: row.entry_id,
      module: row.module,
      itemType: row.item_type,
      label: row.label,
      deletedAt: row.deleted_at,
      expiresAt: row.expires_at,
      deletedByMe: row.deleted_by_me,
      fileCount: row.file_count,
    });
  }
  return { status: "ok", entries };
}
