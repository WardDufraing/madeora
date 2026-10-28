import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  contentArgs,
  databaseFailure,
  outcomeAnswer,
  readMealMutation,
} from "@/meals/route-helpers";
import { createEntrySchema } from "@/meals/schema";

/**
 * Plans a meal in a slot on a date (people who may edit the plan). A taken slot answers `409
 * occupied` with what is there; sending its `replaceKey` back as `replace` replaces it. The id
 * comes from the client, so a retry answers the same meal (`200`).
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readMealMutation(request, createEntrySchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_meal_entry", {
    p_id: body.id,
    p_on: body.date,
    p_slot_id: body.slotId,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
    ...contentArgs(body),
    ...(body.replace === null ? {} : { p_replace: body.replace }),
  });
  if (error) return databaseFailure("meals.create_entry_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.create_entry_failed",
    row?.outcome,
    { id: body.id, revision: row?.revision ?? null },
    { occupied: row?.occupied },
  );
}
