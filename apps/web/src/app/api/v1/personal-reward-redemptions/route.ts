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
import { listPersonalRedemptions, personalClock } from "@/points/personal-data";
import { personalPointsAnswer, refuseOwnerParams } from "@/points/personal-route-helpers";
import { personalRedeemSchema, personalRedemptionViewSchema } from "@/points/personal-schema";

/** The caller's own redemptions (S28b), newest first: `view=all` (default) or `open`. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const refused = refuseOwnerParams(request);
  if (refused) return refused;
  const view = personalRedemptionViewSchema
    .optional()
    .safeParse(new URL(request.url).searchParams.get("view") ?? undefined);
  if (!view.success) return failure(400, "invalid");
  const redemptions = await listPersonalRedemptions(view.data ?? "all");
  if (redemptions.status !== "ok") return failure(500, "failed");
  return json(200, { redemptions: redemptions.value });
}

/**
 * Redeems one of the caller's own rewards at once (S28b), against their own balance. `dryRun`
 * answers the preview (cost, available now and after). A changed cost is refused (`409
 * cost-changed`) so the owner sees the new one; the id comes from the client, so a retry answers
 * `exists`. Windows and period limits use the owner's own timezone and week start.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, personalRedeemSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const redeem = input.data;
  const [supabase, clock] = await Promise.all([createSupabaseServerClient(), personalClock()]);
  const { data, error } = await supabase.rpc("redeem_personal_reward", {
    p_id: redeem.id,
    p_reward_id: redeem.rewardId,
    p_expected_cost: redeem.expectedCost,
    p_dry_run: redeem.dryRun,
    p_today: clock.today,
    p_week_start: clock.weekStart,
  });
  if (error) return databaseFailure("personal_rewards.redeem_failed", error);
  const row = data[0];
  const detail = row ? nullable(row.detail) : null;
  const nextEligibleOn =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as { readonly nextEligibleOn?: unknown }).nextEligibleOn
      : null;
  return personalPointsAnswer(
    "personal_rewards.redeem_failed",
    row?.outcome,
    { outcome: row?.outcome, detail },
    { nextEligibleOn: typeof nextEligibleOn === "string" ? nextEligibleOn : null },
  );
}
