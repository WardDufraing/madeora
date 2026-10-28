import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, outcomeAnswer, readMealMutation } from "@/meals/route-helpers";
import { settingsSchema } from "@/meals/schema";

/** Sets whether a Home's members plan meals (`edit`) or only see the plan (meal managers). */
export async function PATCH(request: Request): Promise<Response> {
  const input = await readMealMutation(request, settingsSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_meal_settings", {
    p_home_id: body.homeId,
    p_expected_revision: body.revision,
    p_member_access: body.memberAccess,
  });
  if (error) return databaseFailure("meals.update_settings_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.update_settings_failed",
    row?.outcome,
    { revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
