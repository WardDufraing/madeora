import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoogleCalendar } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  outcomeOf,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { createGoogleEventSchema } from "@/google-calendar/schema";

/**
 * A new event in one of the person's writable Google calendars (S34). It shows in Madeora at once, marked
 * as saving, and the sync job inserts it in Google with the id Madeora chose, so neither a repeated request
 * nor a retried job makes a second event. The database checks the calendar is theirs and writable, and the
 * times (DST gaps) again.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readGoogleMutation(request, createGoogleEventSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_google_calendar_event", {
    p_request_id: input.data.requestId,
    p_calendar_id: input.data.calendarId,
    p_event: input.data.event,
  });
  if (error) return databaseFailure("google_calendar.create_failed", error);
  const outcome = outcomeOf(data);
  const eventId =
    typeof data === "object" && data !== null && "eventId" in data ? data.eventId : null;
  if (outcome === "created") return json(201, { outcome, eventId });
  if (outcome === "exists") return json(200, { outcome, eventId });
  const refused = outcomeFailure(outcome);
  if (refused) return refused;
  logGoogleCalendar("google_calendar.create_failed", "unexpected_outcome");
  return failure(500, "failed");
}
