import { z } from "zod";

import { readShoppingWidget } from "@/shopping/data";
import { failure, json, requireReader } from "@/shopping/route-helpers";
import { widgetQuerySchema } from "@/shopping/schema";

const rawQuerySchema = z.strictObject({
  homeId: z.string().optional(),
  listIds: z.string().max(1000).optional(),
  limit: z.string().max(3),
});

/**
 * A Shopping widget's rows (S26): the active items of its selected lists of one context (comma
 * separated `listIds`, in the order chosen), read with the person's own session. Selected lists
 * that are archived, deleted or no longer visible are left out and counted, never replaced.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const raw = rawQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!raw.success) return failure(400, "invalid");
  const query = widgetQuerySchema.safeParse({
    homeId: raw.data.homeId ?? null,
    listIds: raw.data.listIds ? raw.data.listIds.split(",") : [],
    limit: Number(raw.data.limit),
  });
  if (!query.success) return failure(400, "invalid");
  const { homeId, listIds, limit } = query.data;
  if (listIds.length === 0) {
    return json(200, { lists: [], unavailable: 0, total: 0, items: [] });
  }
  const widget = await readShoppingWidget(homeId, listIds, limit);
  if (widget.status === "not-found") return failure(404, "not-found");
  if (widget.status === "unavailable") return failure(500, "failed");
  return json(200, widget.value);
}
