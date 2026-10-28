import { createSupabaseServerClient } from "@/auth/supabase-server";
import { todayArg } from "@/meals/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readMealMutation,
} from "@/meals/route-helpers";
import { updateSlotSchema } from "@/meals/schema";

interface SlotRouteContext {
  readonly params: Promise<{ readonly slotId: string }>;
}

/**
 * Renames, disables or enables a slot (meal managers; revision-checked). Disabling one that holds
 * meals answers `409 impact-required` with what it affects until its `impactToken` is sent back.
 * Nothing is deleted or moved.
 */
export async function PATCH(request: Request, { params }: SlotRouteContext): Promise<Response> {
  const input = await readMealMutation(request, updateSlotSchema);
  if (!input.ok) return input.response;
  const slotId = pathId((await params).slotId);
  if (!slotId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_meal_slot", {
    p_slot_id: slotId,
    p_expected_revision: body.revision,
    // Omitted (null): back to the standard name.
    ...(body.name === null ? {} : { p_name: body.name }),
    p_enabled: body.enabled,
    ...(body.impactToken === null ? {} : { p_impact_token: body.impactToken }),
    // A Home's own day wins in the database; this is the Personal space's.
    ...(await todayArg(null)),
  });
  if (error) return databaseFailure("meals.update_slot_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.update_slot_failed",
    row?.outcome,
    { id: slotId, revision: row?.revision ?? null },
    { revision: row?.revision, impact: row?.impact },
  );
}
