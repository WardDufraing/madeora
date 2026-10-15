import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, readNotificationMutation } from "@/notifications/route-helpers";
import { resetPreferenceSchema } from "@/notifications/schema";

/** Removes a Home override (back to inheriting) or the account's own choice (back to the default). */
export async function POST(request: Request): Promise<Response> {
  const input = await readNotificationMutation(request, resetPreferenceSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("reset_notification_preference", {
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
    p_category: input.data.category,
    p_channel: input.data.channel,
  });
  if (error) return databaseFailure("notifications.preference_reset_failed", error);
  return json(200, {});
}
