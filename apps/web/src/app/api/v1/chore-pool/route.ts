import { z } from "zod";

import { getChorePool } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";
import { dateOnlySchema } from "@/tasks/schema";

const querySchema = z.object({ homeId: z.uuid(), date: dateOnlySchema.nullable() });

/**
 * The Home's pool (S21): the unassigned occurrences of the Home-local week holding `date` (today by
 * default) and the overdue ones still available, each with whether the viewer may claim it. Every
 * current member reads it; a Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const search = new URL(request.url).searchParams;
  const query = querySchema.safeParse({
    homeId: search.get("homeId"),
    date: search.get("date"),
  });
  if (!query.success) return failure(400, "invalid");
  const pool = await getChorePool(query.data.homeId, query.data.date);
  if (pool.status === "not-found") return failure(404, "not-found");
  if (pool.status === "unavailable") return failure(500, "failed");
  return json(200, { pool: pool.value });
}
