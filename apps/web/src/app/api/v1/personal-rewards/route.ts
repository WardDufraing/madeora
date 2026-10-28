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
import { listPersonalRewards } from "@/points/personal-data";
import { personalPointsAnswer, refuseOwnerParams } from "@/points/personal-route-helpers";
import { personalRewardCreateSchema, personalRewardFieldArgs } from "@/points/personal-schema";

/**
 * The caller's own personal rewards (S28b) with eligibility, remaining capacity and the next
 * eligible date in their own timezone and week (`archived=true` adds the archived ones).
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const refused = refuseOwnerParams(request);
  if (refused) return refused;
  const archived = z
    .enum(["true", "false"])
    .optional()
    .safeParse(new URL(request.url).searchParams.get("archived") ?? undefined);
  if (!archived.success) return failure(400, "invalid");
  const rewards = await listPersonalRewards(archived.data === "true");
  if (rewards.status !== "ok") return failure(500, "failed");
  return json(200, { rewards: rewards.value });
}

/** Defines one of the caller's own rewards (S28b). The id comes from the client: a retry is `exists`. */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, personalRewardCreateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const reward = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_personal_reward", {
    p_id: reward.id,
    ...personalRewardFieldArgs(reward),
  });
  if (error) return databaseFailure("personal_rewards.create_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return personalPointsAnswer("personal_rewards.create_failed", row?.outcome, {
    outcome: row?.outcome,
    revision,
  });
}
