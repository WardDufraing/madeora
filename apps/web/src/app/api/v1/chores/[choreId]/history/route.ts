import { z } from "zod";

import { listChoreHistory } from "@/chores/data";
import { failure, json, pathId, requireReader } from "@/chores/route-helpers";
import { CHORE_LIMITS, historyFilters } from "@/chores/schema";

interface ChoreRouteContext {
  readonly params: Promise<{ readonly choreId: string }>;
}

const querySchema = z.object({
  filter: z.enum(historyFilters).default("all"),
  offset: z.coerce.number().int().min(0).max(CHORE_LIMITS.maxOffset).default(0),
});

/**
 * One page of a chore's history (S20), newest first: completed, skipped and missed occurrences and
 * today's. Every current member of the chore's Home reads it; anyone else gets not found.
 */
export async function GET(request: Request, { params }: ChoreRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).choreId);
  if (!id) return failure(404, "not-found");
  const search = new URL(request.url).searchParams;
  const query = querySchema.safeParse({
    filter: search.get("filter") ?? undefined,
    offset: search.get("offset") ?? undefined,
  });
  if (!query.success) return failure(400, "invalid");
  const page = await listChoreHistory(id, query.data.filter, query.data.offset);
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}
