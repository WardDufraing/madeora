import { z } from "zod";

import { failure, json, requireReader } from "@/chores/route-helpers";
import { getPointSummary, listPointEntries } from "@/points/data";

/**
 * The caller's own points in one Home (S23; every member): totals, this week, their target and
 * participation, what they may do, and the first page of their ledger (`before` for the next).
 * Only the caller's own balance; a Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const before = z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .safeParse(params.get("before") ?? undefined);
  if (!homeId.success || !before.success) return failure(400, "invalid");
  const [summary, ledger] = await Promise.all([
    getPointSummary(homeId.data),
    listPointEntries(homeId.data, null, before.data ?? null),
  ]);
  if (summary.status === "not-found" || ledger.status === "not-found") {
    return failure(404, "not-found");
  }
  if (summary.status === "unavailable" || ledger.status === "unavailable") {
    return failure(500, "failed");
  }
  return json(200, { summary: summary.value, ledger: ledger.value });
}
