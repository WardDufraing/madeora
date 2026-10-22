import { z } from "zod";

import { failure, json, requireReader } from "@/chores/route-helpers";
import { listPointAccounts } from "@/points/data";

/**
 * Every points account of a Home with its totals (S23; points managers only): current members
 * first, then former members' preserved accounts. Anyone else is answered not found, so balances
 * stay private.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const accounts = await listPointAccounts(homeId.data);
  if (accounts.status === "not-found") return failure(404, "not-found");
  if (accounts.status === "unavailable") return failure(500, "failed");
  return json(200, { accounts: accounts.value });
}
