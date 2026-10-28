import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, outcomeAnswer, readHabitMutation } from "@/habits/route-helpers";
import { settingsSchema } from "@/habits/schema";

/**
 * Sets whether a Home's members check in (`complete`) or only view habits (habit managers), or the
 * person's own milestone celebrations.
 */
export async function PATCH(request: Request): Promise<Response> {
  const input = await readHabitMutation(request, settingsSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  if ("celebrations" in body) {
    const { data, error } = await supabase.rpc("set_habit_celebrations", {
      p_enabled: body.celebrations,
    });
    if (error) return databaseFailure("habits.celebrations_failed", error);
    return outcomeAnswer("habits.celebrations_failed", data, { celebrations: body.celebrations });
  }
  const { data, error } = await supabase.rpc("update_habit_settings", {
    p_home_id: body.homeId,
    p_member_access: body.memberAccess,
  });
  if (error) return databaseFailure("habits.settings_failed", error);
  return outcomeAnswer("habits.settings_failed", data, { memberAccess: body.memberAccess });
}
