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
import { rewardChangeSchema, rewardFieldArgs } from "@/points/schema";

interface RewardRouteContext {
  readonly params: Promise<{ readonly rewardId: string }>;
}

/**
 * Changes a reward (S23; rewards managers): `edit` every field at once (`dryRun` answers the impact:
 * pending and redeemed requests keep their cost), or `archive` / `restore` it. Pending requests,
 * fulfillment and history stay.
 */
export async function PATCH(request: Request, { params }: RewardRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, rewardChangeSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const rewardId = pathId((await params).rewardId);
  if (!rewardId) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } =
    change.action === "edit"
      ? await supabase.rpc("update_reward", {
          p_reward_id: rewardId,
          p_expected_revision: change.expectedRevision,
          p_dry_run: change.dryRun,
          ...rewardFieldArgs(change),
        })
      : await supabase.rpc("archive_reward", {
          p_reward_id: rewardId,
          p_expected_revision: change.expectedRevision,
          p_archived: change.action === "archive",
        });
  if (error) return databaseFailure("rewards.change_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return pointsAnswer(
    "rewards.change_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row ? nullable(row.impact) : null, revision },
    { revision },
  );
}
