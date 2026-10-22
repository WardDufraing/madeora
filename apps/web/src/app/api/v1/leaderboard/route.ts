import { z } from "zod";

import { failure, json, requireReader } from "@/chores/route-helpers";
import { getLeaderboard } from "@/points/data";
import { leaderboardPeriodSchema } from "@/points/schema";

/**
 * The Home's leaderboard for a period (S23; every member, when the Home turned it on): earned
 * points and completed chores of participating members, with shared ranks. Never balances.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const period = leaderboardPeriodSchema.optional().safeParse(params.get("period") ?? undefined);
  if (!homeId.success || !period.success) return failure(400, "invalid");
  const board = await getLeaderboard(homeId.data, period.data ?? null);
  if (board.status === "not-found") return failure(404, "not-found");
  if (board.status === "unavailable") return failure(500, "failed");
  return json(200, board.value);
}
