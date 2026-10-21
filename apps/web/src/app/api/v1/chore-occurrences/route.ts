import { z } from "zod";

import { advanceChores, listChoreOccurrences } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";
import { parseOverviewQuery } from "@/chores/schema";

/**
 * The Home's open chore occurrences (S20): overdue, due today, the next days and any needing
 * reassignment, with the overview's filters. Creates any that are due first (lazy generation).
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const query = parseOverviewQuery(Object.fromEntries(params));
  await advanceChores(homeId.data);
  const page = await listChoreOccurrences(homeId.data, query);
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}
