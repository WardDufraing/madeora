import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  nullable,
  readChoreMutation,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { personalPointsAnswer } from "@/points/personal-route-helpers";
import { personalAdjustmentSchema } from "@/points/personal-schema";

/**
 * A credit or correction to the caller's own personal points (S28b), with a meaningful reason.
 * `dryRun` answers the preview (available now and after). A debit never takes the balance below
 * zero (`409 insufficient-points`, nothing applied). The id comes from the client, so a retry
 * answers `exists`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, personalAdjustmentSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const adjustment = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("adjust_personal_points", {
    p_id: adjustment.id,
    p_kind: adjustment.kind,
    p_amount: adjustment.amount,
    p_reason: adjustment.reason,
    p_dry_run: adjustment.dryRun,
  });
  if (error) return databaseFailure("personal_points.adjust_failed", error);
  const row = data[0];
  return personalPointsAnswer("personal_points.adjust_failed", row?.outcome, {
    outcome: row?.outcome,
    preview: row ? nullable(row.preview) : null,
    entryId: row ? nullable(row.entry_id) : null,
  });
}
