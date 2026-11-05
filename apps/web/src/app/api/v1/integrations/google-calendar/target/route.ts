import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoogleCalendar } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { writeTargetSchema } from "@/google-calendar/schema";

/**
 * The Google calendar new Madeora events go to (S34), or none (Madeora only). The database checks it is
 * one of the person's synced calendars that Google lets them write.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readGoogleMutation(request, writeTargetSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "set_google_calendar_write_target",
    input.data.calendarId === null ? {} : { p_calendar_id: input.data.calendarId },
  );
  if (error) return databaseFailure("google_calendar.target_failed", error);
  if (data === "saved") return json(200, { outcome: "saved" });
  const refused = outcomeFailure(data);
  if (refused) return refused;
  logGoogleCalendar("google_calendar.target_failed", "unexpected_outcome");
  return failure(500, "failed");
}
