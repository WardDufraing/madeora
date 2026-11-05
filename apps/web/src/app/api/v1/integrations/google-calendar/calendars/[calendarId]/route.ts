import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pathId } from "@/calendar/route-helpers";
import { logGoogleCalendar } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { googleCalendarSettingsSchema } from "@/google-calendar/schema";

interface Context {
  readonly params: Promise<{ readonly calendarId: string }>;
}

/**
 * One of the person's Google calendars (S33): whether it syncs, shows on their personal calendar and
 * which of their Homes see it. The database checks that the calendar is theirs and every Home one they
 * belong to; turning sync off removes its events and shares.
 */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const input = await readGoogleMutation(request, googleCalendarSettingsSchema);
  if (!input.ok) return input.response;
  const calendarId = pathId((await context.params).calendarId);
  if (!calendarId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_google_calendar_settings", {
    p_calendar_id: calendarId,
    p_sync: input.data.sync,
    p_show_personal: input.data.showPersonal,
    p_home_ids: input.data.homes,
  });
  if (error) return databaseFailure("google_calendar.settings_failed", error);
  switch (data) {
    case "saved":
      return json(200, { outcome: "saved" });
    case "not_found":
      return failure(404, "not-found");
    case "unavailable":
      return failure(409, "unavailable");
    case "invalid_home":
      return failure(400, "invalid-home");
    case "too_many":
      return failure(409, "too-many");
    default:
      logGoogleCalendar("google_calendar.settings_failed", "unexpected_outcome");
      return failure(500, "failed");
  }
}
