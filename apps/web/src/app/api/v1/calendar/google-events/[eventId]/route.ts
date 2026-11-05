import { getVerifiedIdentity } from "@/auth/identity";
import { pathId } from "@/calendar/route-helpers";
import { readGoogleEvent } from "@/google-calendar/data";
import { failure, json } from "@/google-calendar/route-helpers";

interface Context {
  readonly params: Promise<{ readonly eventId: string }>;
}

/** One Google event as the person sees it in a context (`?homeId=`; none: Personal). Read-only (S33). */
export async function GET(request: Request, context: Context): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const eventId = pathId((await context.params).eventId);
  const homeParam = new URL(request.url).searchParams.get("homeId");
  const homeId = homeParam === null ? null : pathId(homeParam);
  if (!eventId || (homeParam !== null && !homeId)) return failure(404, "not-found");
  const read = await readGoogleEvent(eventId, homeId);
  if (read.status === "ok") return json(200, { event: read.value });
  if (read.status === "not-found") return failure(404, "not-found");
  return failure(500, "failed");
}
