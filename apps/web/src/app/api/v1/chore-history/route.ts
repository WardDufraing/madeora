import { z } from "zod";

import { listHomeChoreHistory } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";
import { CHORE_LIMITS, parseHomeHistoryQuery } from "@/chores/schema";

/**
 * One page of a Home's chore history (S20; spec "Confirmed searchable Home-wide chore completion
 * history"), newest first, with search and filters (unknown values fall back to their defaults).
 * Every current member of the Home reads it; a Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const search = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(search.get("homeId"));
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(CHORE_LIMITS.maxOffset)
    .default(0)
    .safeParse(search.get("offset") ?? undefined);
  if (!homeId.success || !offset.success) return failure(400, "invalid");
  const query = parseHomeHistoryQuery(Object.fromEntries(search.entries()));
  const page = await listHomeChoreHistory(homeId.data, query, offset.data);
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}
