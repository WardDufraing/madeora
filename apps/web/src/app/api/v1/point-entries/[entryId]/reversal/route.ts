import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  pathId,
  readChoreMutation,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { pointsAnswer } from "@/points/route-helpers";
import { reversalSchema } from "@/points/schema";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

/**
 * Reverses one bonus or correction with a linked entry (S23; points managers), once, with a reason.
 * `dryRun` answers the preview. The reversal follows the same rule as a debit.
 */
export async function POST(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, reversalSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reverse_point_entry", {
    p_entry_id: entryId,
    p_reason: input.data.reason,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("points.reverse_failed", error);
  const row = data[0];
  return pointsAnswer("points.reverse_failed", row?.outcome, {
    outcome: row?.outcome,
    preview: row ? nullable(row.preview) : null,
    entryId: row ? nullable(row.entry_id) : null,
  });
}
