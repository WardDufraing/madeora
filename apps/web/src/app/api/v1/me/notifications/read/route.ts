import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  json,
  MAX_READ_BODY_BYTES,
  readNotificationMutation,
} from "@/notifications/route-helpers";
import { markReadSchema } from "@/notifications/schema";

/**
 * Marks the signed-in person's notifications read: the listed ids (at most 100) or all of them
 * (S14). The database function only touches their own rows, and none of a Home they have left.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readNotificationMutation(request, markReadSchema, MAX_READ_BODY_BYTES);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("mark_notifications_read", {
    ...("ids" in input.data ? { p_ids: input.data.ids } : {}),
  });
  if (error) return databaseFailure("notifications.mark_read_failed", error);
  return json(200, { updated: data });
}
