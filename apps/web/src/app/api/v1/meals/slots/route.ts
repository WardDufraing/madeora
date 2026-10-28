import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, outcomeAnswer, readMealMutation } from "@/meals/route-helpers";
import { createSlotSchema } from "@/meals/schema";

/** Adds a custom slot at the end (meal managers; at most 8). A retry with the same id answers 200. */
export async function POST(request: Request): Promise<Response> {
  const input = await readMealMutation(request, createSlotSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_meal_slot", {
    p_id: body.id,
    p_name: body.name,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
  });
  if (error) return databaseFailure("meals.create_slot_failed", error);
  const row = data[0];
  return outcomeAnswer("meals.create_slot_failed", row?.outcome, {
    id: body.id,
    revision: row?.revision ?? null,
  });
}
