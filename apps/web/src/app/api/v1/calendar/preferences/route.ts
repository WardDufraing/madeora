import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, readCalendarMutation } from "@/calendar/route-helpers";
import { calendarPreferencesSchema } from "@/calendar/schema";

/**
 * The person's own view settings for one calendar (presentation only): Home vacations, and the
 * task and chore overlays. The database checks the Home membership again.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readCalendarMutation(request, calendarPreferencesSchema);
  if (!input.ok) return input.response;
  const { homeId, showVacations, showTasks, showChores } = input.data;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_calendar_preferences", {
    ...(homeId ? { p_home_id: homeId } : {}),
    ...(showVacations === undefined ? {} : { p_show_vacations: showVacations }),
    ...(showTasks === undefined ? {} : { p_show_tasks: showTasks }),
    ...(showChores === undefined ? {} : { p_show_chores: showChores }),
  });
  if (error) return databaseFailure("calendar.preferences_failed", error);
  return json(200, { outcome: "ok" });
}
