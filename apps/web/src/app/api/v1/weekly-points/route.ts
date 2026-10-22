import { z } from "zod";

import { failure, json, requireReader } from "@/chores/route-helpers";
import { getWeeklyPoints } from "@/points/data";

/**
 * The weekly points overview (S23; every member): the caller's own week, or with `shared=true`
 * every participating member's earned, pending and possible points (shared targets only) and the
 * unassigned pool's possible points. Never a ranking or a balance.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const shared = z
    .enum(["true", "false"])
    .optional()
    .safeParse(params.get("shared") ?? undefined);
  if (!homeId.success || !shared.success) return failure(400, "invalid");
  const weekly = await getWeeklyPoints(homeId.data, shared.data === "true");
  if (weekly.status === "not-found") return failure(404, "not-found");
  if (weekly.status === "unavailable") return failure(500, "failed");
  return json(200, weekly.value);
}
