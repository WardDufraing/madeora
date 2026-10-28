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
import { personalRedemptionChangeSchema } from "@/points/personal-schema";

interface RedemptionRouteContext {
  readonly params: Promise<{ readonly redemptionId: string }>;
}

/**
 * Changes one of the caller's own redemptions (S28b): `fulfillment` records Pending, Fulfilled or
 * Unable to fulfill (a correction after Fulfilled or Unable needs a reason); `resolve` settles an
 * Unable-to-fulfill reward once by a refund or a replacement (`dryRun` answers the impact). Anyone
 * else's redemption is not found, like a missing one.
 */
export async function PATCH(
  request: Request,
  { params }: RedemptionRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, personalRedemptionChangeSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const redemptionId = pathId((await params).redemptionId);
  if (!redemptionId) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  if (change.action === "fulfillment") {
    const { data, error } = await supabase.rpc("set_personal_reward_fulfillment", {
      p_redemption_id: redemptionId,
      p_expected_revision: change.expectedRevision,
      p_state: change.state,
      ...(change.note !== null ? { p_note: change.note } : {}),
    });
    if (error) return databaseFailure("personal_rewards.fulfillment_failed", error);
    const row = data[0];
    const revision = row ? nullable(row.revision) : null;
    return personalPointsAnswer(
      "personal_rewards.fulfillment_failed",
      row?.outcome,
      { outcome: row?.outcome, impact: null, revision },
      { revision },
    );
  }
  const { data, error } = await supabase.rpc("resolve_personal_reward_redemption", {
    p_redemption_id: redemptionId,
    p_expected_revision: change.expectedRevision,
    p_resolution: change.resolution,
    p_dry_run: change.dryRun,
    ...(change.note !== null ? { p_note: change.note } : {}),
    ...(change.replacement !== null ? { p_replacement: change.replacement } : {}),
  });
  if (error) return databaseFailure("personal_rewards.resolve_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return personalPointsAnswer(
    "personal_rewards.resolve_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row ? nullable(row.impact) : null, revision },
    { revision },
  );
}
