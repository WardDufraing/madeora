import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, readNotificationMutation } from "@/notifications/route-helpers";
import { resetQuietHoursSchema } from "@/notifications/schema";

/** Removes a Home's quiet-hours override (back to the account's) or the account's own. */
export async function POST(request: Request): Promise<Response> {
  const input = await readNotificationMutation(request, resetQuietHoursSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("reset_notification_quiet_hours", {
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
  });
  if (error) return databaseFailure("notifications.quiet_hours_reset_failed", error);
  return json(200, {});
}
