import { z } from "zod";

import { failure, json, pathId, requireReader } from "@/chores/route-helpers";
import { listPointEntries } from "@/points/data";

interface AccountRouteContext {
  readonly params: Promise<{ readonly accountId: string }>;
}

/**
 * One account's ledger page, newest first (S23): its holder or a points manager. Anyone else is
 * answered not found.
 */
export async function GET(request: Request, { params }: AccountRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const accountId = pathId((await params).accountId);
  if (!accountId) return failure(404, "not-found");
  const search = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(search.get("homeId"));
  const before = z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .safeParse(search.get("before") ?? undefined);
  if (!homeId.success || !before.success) return failure(400, "invalid");
  const ledger = await listPointEntries(homeId.data, accountId, before.data ?? null);
  if (ledger.status === "not-found") return failure(404, "not-found");
  if (ledger.status === "unavailable") return failure(500, "failed");
  return json(200, ledger.value);
}
