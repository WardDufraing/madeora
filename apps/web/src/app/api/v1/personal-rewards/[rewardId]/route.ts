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
import { personalRewardChangeSchema, personalRewardFieldArgs } from "@/points/personal-schema";

interface RewardRouteContext {
  readonly params: Promise<{ readonly rewardId: string }>;
}

/**
 * Changes one of the caller's own rewards (S28b): `edit` every field at once (`dryRun` answers the
 * impact; past redemptions keep their cost), or `archive` / `restore` it. Anyone else's reward is
 * not found, like a missing one.
 */
export async function PATCH(request: Request, { params }: RewardRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, personalRewardChangeSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const rewardId = pathId((await params).rewardId);
  if (!rewardId) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  if (change.action === "edit") {
    const { data, error } = await supabase.rpc("update_personal_reward", {
      p_reward_id: rewardId,
      p_expected_revision: change.expectedRevision,
      p_dry_run: change.dryRun,
      ...personalRewardFieldArgs(change),
    });
    if (error) return databaseFailure("personal_rewards.change_failed", error);
    const row = data[0];
    const revision = row ? nullable(row.revision) : null;
    return personalPointsAnswer(
      "personal_rewards.change_failed",
      row?.outcome,
      { outcome: row?.outcome, impact: row ? nullable(row.impact) : null, revision },
      { revision },
    );
  }
  const { data, error } = await supabase.rpc("archive_personal_reward", {
    p_reward_id: rewardId,
    p_expected_revision: change.expectedRevision,
    p_archived: change.action === "archive",
  });
  if (error) return databaseFailure("personal_rewards.change_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return personalPointsAnswer(
    "personal_rewards.change_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: null, revision },
    { revision },
  );
}
