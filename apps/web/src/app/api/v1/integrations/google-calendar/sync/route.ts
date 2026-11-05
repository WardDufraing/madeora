import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoogleCalendar } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { emptyBodySchema } from "@/google-calendar/schema";

/** Sync now (S33): queues a run of the person's own connection, at most once a minute. */
export async function POST(request: Request): Promise<Response> {
  const input = await readGoogleMutation(request, emptyBodySchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_google_calendar_sync");
  if (error) return databaseFailure("google_calendar.sync_failed", error);
  switch (data) {
    case "queued":
      return json(200, { outcome: "queued" });
    case "too_soon":
      return failure(429, "too-soon");
    case "not_connected":
      return failure(404, "not-found");
    case "authorization_expired":
      return failure(409, "authorization-expired");
    default:
      logGoogleCalendar("google_calendar.sync_failed", "unexpected_outcome");
      return failure(500, "failed");
  }
}
