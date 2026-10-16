import { getVerifiedIdentity } from "@/auth/identity";
import type { TrashListResponse } from "@/trash/api";
import { listTrash } from "@/trash/data";
import { failure, json } from "@/trash/route-helpers";
import { listQuerySchema } from "@/trash/schema";

const FILTERS = ["homeId", "module", "itemType", "deletedFrom", "deletedTo"] as const;

/**
 * The signed-in person's trash (S16): their personal trash, or with `homeId` that Home's, showing
 * only what they may see. The database decides (`public.list_trash`, with their own session); a Home
 * they do not belong to answers 404 like one that does not exist.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const name of FILTERS) {
    const value = params.get(name);
    if (value !== null && value !== "") raw[name] = value;
  }
  for (const name of params.keys()) {
    if (!(FILTERS as readonly string[]).includes(name)) return failure(400, "invalid", [name]);
  }
  const query = listQuerySchema.safeParse(raw);
  if (!query.success) return failure(400, "invalid", Object.keys(raw));

  const result = await listTrash(query.data);
  if (result.status === "not-found") return failure(404, "not-found");
  if (result.status === "unavailable") return failure(500, "failed");
  const body: TrashListResponse = { entries: result.entries };
  return json(200, body);
}
