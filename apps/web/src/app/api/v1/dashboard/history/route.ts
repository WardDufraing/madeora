import { getVerifiedIdentity } from "@/auth/identity";
import { listHistory } from "@/dashboard/history-server";
import { failure, json } from "@/dashboard/route-helpers";
import type { DashboardTarget } from "@/dashboard/schema";
import { loadTarget } from "@/dashboard/server";
import { homeIdSchema } from "@/homes/schema";

/**
 * A dashboard's version history (UX2c; redesign decision 32): the 10 most recent committed layouts,
 * newest first, each with when, why (edit, Undo, restore), whether the reader saved it, and its
 * arrangement for a preview (widget types and places only, never settings or content).
 *
 * `GET ?homeId` (none: the personal dashboard) → `200 { versions }`. Only someone who may edit the
 * dashboard sees its history: `403 not-permitted` for a Member of the Home who may not, `404` for
 * a Home the person does not belong to (indistinguishable from none). The database applies the same
 * rules again with the person's own session.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const params = new URL(request.url).searchParams;
  for (const name of params.keys()) {
    if (name !== "homeId") return failure(400, "invalid", { fields: [name] });
  }
  const raw = params.get("homeId");
  let target: DashboardTarget = { kind: "personal" };
  if (raw !== null) {
    const homeId = homeIdSchema.safeParse(raw);
    if (!homeId.success) return failure(400, "invalid", { fields: ["homeId"] });
    target = { kind: "home", homeId: homeId.data };
  }

  const current = await loadTarget(target);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  if (!current.dashboard.canEdit) return failure(403, "not-permitted");

  const history = await listHistory(target);
  if (history.status === "not-found") return failure(403, "not-permitted");
  if (history.status === "unavailable") return failure(500, "unavailable");
  return json(200, { versions: history.versions });
}
