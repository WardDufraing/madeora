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
import { listRewards } from "@/points/data";
import { pointsAnswer } from "@/points/route-helpers";
import { rewardCreateSchema, rewardFieldArgs } from "@/points/schema";

/**
 * A Home's rewards (S23): the enabled catalog for every member, with eligibility, remaining
 * capacity and the next eligible date; every reward for rewards managers (`archived=true` adds the
 * archived ones).
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const archived = z
    .enum(["true", "false"])
    .optional()
    .safeParse(params.get("archived") ?? undefined);
  if (!homeId.success || !archived.success) return failure(400, "invalid");
  const rewards = await listRewards(homeId.data, archived.data === "true");
  if (rewards.status === "not-found") return failure(404, "not-found");
  if (rewards.status === "unavailable") return failure(500, "failed");
  return json(200, { rewards: rewards.value });
}

/** Creates a reward (S23; rewards managers). The id comes from the client, so a retry answers `exists`. */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, rewardCreateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const reward = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_reward", {
    p_id: reward.id,
    p_home_id: reward.homeId,
    ...rewardFieldArgs(reward),
  });
  if (error) return databaseFailure("rewards.create_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return pointsAnswer("rewards.create_failed", row?.outcome, { outcome: row?.outcome, revision });
}
