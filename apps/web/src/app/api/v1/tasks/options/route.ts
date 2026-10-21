import { z } from "zod";

import { failure, json, requireReader } from "@/tasks/route-helpers";
import { loadTaskOptions } from "@/tasks/widget-data";

/**
 * The lists, labels and members of the Personal space or a Home (S19c), for a tasks widget's
 * settings. Read with the person's own session: a Home they are not in answers 404, like one that
 * does not exist.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z
    .uuid()
    .optional()
    .safeParse(new URL(request.url).searchParams.get("homeId") ?? undefined);
  if (!homeId.success) return failure(400, "invalid");
  const loaded = await loadTaskOptions(homeId.data ?? null);
  if (loaded.status !== "ok") {
    return loaded.status === "not-found" ? failure(404, "not-found") : failure(500, "failed");
  }
  return json(200, loaded.options);
}
