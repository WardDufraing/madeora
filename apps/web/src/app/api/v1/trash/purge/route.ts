import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { PurgeResponse } from "@/trash/api";
import { databaseFailure, failure, json, readTrashMutation } from "@/trash/route-helpers";
import { purgeSchema } from "@/trash/schema";

import { purgeResults } from "../purge-results";

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Deletes the chosen entries permanently, before their 7-day window ends (S16; spec "Confirmed
 * early permanent deletion from file trash"). The body must carry `confirm: true`, the explicit
 * "this cannot be undone" the person gave. The database rechecks the person's rights for every
 * entry and skips the ones they may not delete; their files' space is released.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTrashMutation(request, purgeSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("purge_trash_entries", {
    p_entry_ids: input.data.entryIds,
  });
  if (error) return databaseFailure("trash.purge_failed", error);
  if (data.length === 0) return failure(500, "failed");
  const body: PurgeResponse = { results: purgeResults(data) };
  return json(200, body);
}
