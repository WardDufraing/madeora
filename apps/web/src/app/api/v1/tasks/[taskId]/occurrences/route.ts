import { z } from "zod";

import { listTaskOccurrences } from "@/tasks/data";
import { failure, json, requireReader } from "@/tasks/route-helpers";
import { occurrenceQuerySchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * A page of the series' history from one of its occurrences (S19), newest first: scheduled date,
 * status (completed, completed late, missed, open) and the actual completer. A task the person
 * cannot see, or one that is not recurring, gives none.
 */
export async function GET(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const search = new URL(request.url).searchParams;
  const query = occurrenceQuerySchema.safeParse({
    ...(search.has("filter") ? { filter: search.get("filter") } : {}),
    ...(search.has("offset") ? { offset: search.get("offset") } : {}),
  });
  if (!query.success) return failure(400, "invalid");
  const page = await listTaskOccurrences(id.data, query.data.filter, query.data.offset);
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}
