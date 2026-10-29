import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, outcomeAnswer, readGoalMutation } from "@/goals/route-helpers";
import { settingsSchema } from "@/goals/schema";

/** Sets whether a Home's members contribute to its goals or only view them (goal managers). */
export async function PATCH(request: Request): Promise<Response> {
  const input = await readGoalMutation(request, settingsSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_goal_settings", {
    p_home_id: body.homeId,
    p_member_access: body.memberAccess,
  });
  if (error) return databaseFailure("goals.settings_failed", error);
  return outcomeAnswer("goals.settings_failed", data, { memberAccess: body.memberAccess });
}
