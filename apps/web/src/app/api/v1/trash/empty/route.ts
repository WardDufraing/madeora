import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { PurgeResponse } from "@/trash/api";
import { databaseFailure, json, readTrashMutation } from "@/trash/route-helpers";
import { emptySchema } from "@/trash/schema";

import { purgeResults } from "../purge-results";

const MAX_BODY_BYTES = 512;

/**
 * Empties the signed-in person's personal trash, or a Home's (S16; spec "Confirmed early permanent
 * deletion from file trash"): everything they may delete now, up to one batch. Entries they may not
 * see are neither touched nor mentioned. `confirm: true` is required. Call it again for the rest.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTrashMutation(request, emptySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("empty_trash", {
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
    p_deleted_before: input.data.deletedBefore,
  });
  if (error) return databaseFailure("trash.empty_failed", error);
  const body: PurgeResponse = { results: purgeResults(data) };
  return json(200, body);
}
