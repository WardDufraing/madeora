import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { RestoreResponse, RestoreResult } from "@/trash/api";
import { databaseFailure, failure, json, readTrashMutation } from "@/trash/route-helpers";
import { restoreSchema, trashResolutions, type TrashResolution } from "@/trash/schema";

const MAX_BODY_BYTES = 8 * 1024;
/** Widens a value to include null, because the generated database types do not. */
function nullable<T>(value: T): T | null {
  return value;
}

const OUTCOMES = ["restored", "needs_resolution", "expired", "not_found"] as const;

/**
 * Restores the chosen entries, each on its own (S16): a conflict, an expired entry or a failure in
 * one never stops the others, and nothing active is overwritten. The database rechecks the person's
 * current rights, the recovery deadline and every conflict for each entry; an entry they may not see
 * is reported exactly like one that does not exist.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTrashMutation(request, restoreSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("restore_trash_entries", {
    p_entry_ids: input.data.entryIds,
    p_resolutions: input.data.resolutions ?? {},
  });
  if (error) return databaseFailure("trash.restore_failed", error);

  const results: RestoreResult[] = data.map((row) => {
    // The generated types call these columns non-null; the database leaves them null for outcomes
    // that have no conflict or options.
    const conflict = nullable(row.conflict);
    const options = nullable<readonly string[]>(row.options);
    return {
      entryId: row.entry_id,
      outcome: OUTCOMES.find((outcome) => outcome === row.outcome) ?? "failed",
      conflict,
      options: (options ?? []).filter((option): option is TrashResolution =>
        (trashResolutions as readonly string[]).includes(option),
      ),
      attachmentsLost: row.attachments_lost,
    };
  });
  const body: RestoreResponse = { results };
  return results.length > 0 ? json(200, body) : failure(500, "failed");
}
