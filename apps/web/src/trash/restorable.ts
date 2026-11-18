import "server-only";

import type { createSupabaseServerClient } from "@/auth/supabase-server";

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Whether the signed-in caller may restore a trash entry right now (S16-4: a Home's trash is for its
 * Owner and managers). A delete answers with it, so the page offers Undo only to someone whose Undo
 * would work. Any failure answers false: a missing Undo is safer than one that cannot succeed.
 */
export async function isEntryRestorable(
  supabase: ServerClient,
  entryId: string | null,
): Promise<boolean> {
  if (!entryId) return false;
  const { data, error } = await supabase.rpc("can_restore_trash_entry", { p_entry_id: entryId });
  return !error && data;
}
