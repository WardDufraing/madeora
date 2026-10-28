import { z } from "zod";

import { failure, json, requireReader } from "@/chores/route-helpers";
import { getPersonalPoints } from "@/points/personal-data";
import { refuseOwnerParams } from "@/points/personal-route-helpers";

/**
 * The caller's own personal points (S28b): available, earned and spent, and one page of their
 * ledger (`before` for the next). Only ever the signed-in person's own; it names no Home, and a
 * `homeId` is refused.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const refused = refuseOwnerParams(request);
  if (refused) return refused;
  const before = z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .safeParse(new URL(request.url).searchParams.get("before") ?? undefined);
  if (!before.success) return failure(400, "invalid");
  const points = await getPersonalPoints(before.data ?? null);
  if (points.status !== "ok") return failure(500, "failed");
  return json(200, points.value);
}
