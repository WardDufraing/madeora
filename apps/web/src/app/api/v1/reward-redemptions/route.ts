import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  readChoreMutation,
  requireReader,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { listRedemptions } from "@/points/data";
import { pointsAnswer } from "@/points/route-helpers";
import { redeemSchema, redemptionViewSchema } from "@/points/schema";

/**
 * Redemptions of a Home by view (S23): `mine` (the caller's own), `approvals` (pending requests,
 * reviewers), `fulfillment` (redeemed and not settled, rewards managers), `all` (rewards managers).
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const view = redemptionViewSchema.safeParse(params.get("view") ?? "mine");
  if (!homeId.success || !view.success) return failure(400, "invalid");
  const list = await listRedemptions(homeId.data, view.data);
  if (list.status === "not-found") return failure(404, "not-found");
  if (list.status === "unavailable") return failure(500, "failed");
  return json(200, { redemptions: list.value });
}

/**
 * Redeems a reward for the caller (S23; any current member): at once, or as a request when it needs
 * approval (the cost is reserved). `dryRun` answers the preview; a changed cost answers
 * `409 cost-changed` so the member confirms the new one. The id comes from the client, so a retry
 * answers `exists`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, redeemSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const redeem = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("redeem_reward", {
    p_id: redeem.id,
    p_reward_id: redeem.rewardId,
    p_expected_cost: redeem.expectedCost,
    p_dry_run: redeem.dryRun,
  });
  if (error) return databaseFailure("rewards.redeem_failed", error);
  const row = data[0];
  const detail = row ? nullable(row.detail) : null;
  const nextEligible =
    detail && typeof detail === "object" && !Array.isArray(detail) ? detail.nextEligibleOn : null;
  return pointsAnswer(
    "rewards.redeem_failed",
    row?.outcome,
    { outcome: row?.outcome, detail },
    { nextEligibleOn: typeof nextEligible === "string" ? nextEligible : null },
  );
}
