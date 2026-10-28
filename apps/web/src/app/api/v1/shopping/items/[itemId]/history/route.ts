import { getShoppingItemHistory } from "@/shopping/data";
import { failure, json, pathId, requireReader } from "@/shopping/route-helpers";

interface ItemRouteContext {
  readonly params: Promise<{ readonly itemId: string }>;
}

/**
 * An item's latest 20 history entries, newest first (current members of its context only). Every
 * visible item has at least one entry, so none answers like an item that does not exist.
 */
export async function GET(_request: Request, { params }: ItemRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const history = await getShoppingItemHistory(itemId);
  if (history.status === "not-found") return failure(404, "not-found");
  if (history.status === "unavailable") return failure(500, "failed");
  if (history.value.length === 0) return failure(404, "not-found");
  return json(200, { entries: history.value });
}
