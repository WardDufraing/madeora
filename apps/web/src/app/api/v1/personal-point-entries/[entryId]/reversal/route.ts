import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  pathId,
  readChoreMutation,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { personalPointsAnswer } from "@/points/personal-route-helpers";
import { personalReversalSchema } from "@/points/personal-schema";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

/**
 * Reverses one of the caller's own credits or corrections with a linked entry (S28b), once, with a
 * reason. `dryRun` answers the preview. Anyone else's entry is not found, like a missing one.
 */
export async function POST(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, personalReversalSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reverse_personal_point_entry", {
    p_entry_id: entryId,
    p_reason: input.data.reason,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("personal_points.reverse_failed", error);
  const row = data[0];
  return personalPointsAnswer("personal_points.reverse_failed", row?.outcome, {
    outcome: row?.outcome,
    preview: row ? nullable(row.preview) : null,
    entryId: row ? nullable(row.entry_id) : null,
  });
}
