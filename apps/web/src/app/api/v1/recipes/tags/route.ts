import { z } from "zod";

import { listRecipeTags } from "@/recipes/data";
import { failure, json, requireReader } from "@/recipes/route-helpers";

/** The tags of a context's published recipes with their counts (S24), for the library filter. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z
    .uuid()
    .optional()
    .safeParse(new URL(request.url).searchParams.get("homeId") ?? undefined);
  if (!homeId.success) return failure(400, "invalid");
  const tags = await listRecipeTags(homeId.data ?? null);
  if (tags.status === "not-found") return failure(404, "not-found");
  if (tags.status === "unavailable") return failure(500, "failed");
  return json(200, { tags: tags.value });
}
