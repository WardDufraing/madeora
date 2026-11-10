import { databaseFailure, json, readActivityMutation } from "@/activity/route-helpers";
import { securityAlertsSchema } from "@/activity/schema";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * The signed-in person's routine sign-in alert choices (S38): new-device sign-ins and every
 * successful sign-in. Mandatory security alerts are not settings and cannot be turned off.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readActivityMutation(request, securityAlertsSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_security_alert_preferences", {
    p_new_device: input.data.newDevice,
    p_every_sign_in: input.data.everySignIn,
  });
  if (error) return databaseFailure("activity.alerts_failed", error);
  return json(200, {});
}
