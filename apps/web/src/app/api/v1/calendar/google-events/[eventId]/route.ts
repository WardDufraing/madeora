import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pathId } from "@/calendar/route-helpers";
import { logGoogleCalendar, readGoogleEvent } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  outcomeOf,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { deleteGoogleEventSchema, updateGoogleEventSchema } from "@/google-calendar/schema";

interface Context {
  readonly params: Promise<{ readonly eventId: string }>;
}

/** One Google event as the person sees it in a context (`?homeId=`; none: Personal) (S33). */
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

function answer(event: string, data: unknown): Response {
  const outcome = outcomeOf(data);
  if (
    outcome === "saved" ||
    outcome === "unchanged" ||
    outcome === "preview" ||
    outcome === "removed" ||
    outcome === "deleting"
  ) {
    return json(200, typeof data === "object" && data !== null ? data : { outcome });
  }
  const refused = outcomeFailure(outcome);
  if (refused) return refused;
  logGoogleCalendar(event, "unexpected_outcome");
  return failure(500, "failed");
}

/**
 * Changes a Google event from Madeora (S34): this event, this and following, or all events of its series.
 * Only its owner, in a calendar Google lets them write; `revision` refuses a change made from an older page.
 * `dryRun` answers the occurrences it affects and changes nothing.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const input = await readGoogleMutation(request, updateGoogleEventSchema);
  if (!input.ok) return input.response;
  const eventId = pathId((await context.params).eventId);
  if (!eventId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_google_calendar_event", {
    p_event_id: eventId,
    p_scope: input.data.scope,
    p_revision: input.data.revision,
    p_event: input.data.event,
    p_dry_run: input.data.dryRun ?? false,
  });
  if (error) return databaseFailure("google_calendar.update_failed", error);
  return answer("google_calendar.update_failed", data);
}

/**
 * Deletes a Google event after the person chose where (Modules.md §4.2): "Remove from Madeora" hides it
 * (Google untouched, restorable from Settings); "Delete everywhere" waits for Google's confirmation.
 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const input = await readGoogleMutation(request, deleteGoogleEventSchema);
  if (!input.ok) return input.response;
  const eventId = pathId((await context.params).eventId);
  if (!eventId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_google_calendar_event", {
    p_event_id: eventId,
    p_scope: input.data.scope,
    p_destination: input.data.destination,
    p_revision: input.data.revision,
    p_dry_run: input.data.dryRun ?? false,
  });
  if (error) return databaseFailure("google_calendar.delete_failed", error);
  return answer("google_calendar.delete_failed", data);
}
