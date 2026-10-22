import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  nullable,
  readChoreMutation,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { pointsAnswer } from "@/points/route-helpers";
import { adjustmentSchema } from "@/points/schema";

/**
 * A bonus or correction to a current member's points (S23; points managers), with a meaningful
 * reason. `dryRun` answers the preview (available now and after). A debit never takes available
 * points below zero (`409 insufficient-points`, nothing applied). The id comes from the client, so
 * a retry answers `exists`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, adjustmentSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const adjustment = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("adjust_points", {
    p_id: adjustment.id,
    p_home_id: adjustment.homeId,
    p_member: adjustment.memberId,
    p_kind: adjustment.kind,
    p_amount: adjustment.amount,
    p_reason: adjustment.reason,
    p_dry_run: adjustment.dryRun,
  });
  if (error) return databaseFailure("points.adjust_failed", error);
  const row = data[0];
  return pointsAnswer("points.adjust_failed", row?.outcome, {
    outcome: row?.outcome,
    preview: row ? nullable(row.preview) : null,
    entryId: row ? nullable(row.entry_id) : null,
  });
}
