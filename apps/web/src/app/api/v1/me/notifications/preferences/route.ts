import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readNotificationMutation,
} from "@/notifications/route-helpers";
import { preferenceSchema } from "@/notifications/schema";

/**
 * Sets one notification choice for the account's defaults (`homeId: null`) or as an override for
 * one Home the person belongs to (S14). Only the person manages their own delivery preferences:
 * the function writes with their session, to their own rows.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readNotificationMutation(request, preferenceSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_notification_preference", {
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
    p_category: input.data.category,
    p_channel: input.data.channel,
    p_enabled: input.data.enabled,
  });
  if (error) return databaseFailure("notifications.preference_failed", error);
  if (data === "not_found") return failure(404, "not-found");
  return json(200, {});
}
