import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readNotificationMutation,
} from "@/notifications/route-helpers";
import { quietHoursSchema } from "@/notifications/schema";

/**
 * Sets quiet hours for the account (`homeId: null`) or for one Home the person belongs to (S14).
 * Wall-clock times in the given IANA zone; an overnight window (22:00 to 07:00) is one window.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readNotificationMutation(request, quietHoursSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_notification_quiet_hours", {
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
    p_enabled: input.data.enabled,
    p_start: input.data.start,
    p_end: input.data.end,
    p_time_zone: input.data.timeZone,
  });
  if (error) return databaseFailure("notifications.quiet_hours_failed", error);
  if (data === "not_found") return failure(404, "not-found");
  return json(200, {});
}
