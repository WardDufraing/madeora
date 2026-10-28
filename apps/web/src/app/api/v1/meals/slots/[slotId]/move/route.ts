import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readMealMutation,
} from "@/meals/route-helpers";
import { moveSlotSchema } from "@/meals/schema";

interface MoveRouteContext {
  readonly params: Promise<{ readonly slotId: string }>;
}

/** Moves a slot one place up or down (meal managers): the keyboard alternative to dragging. */
export async function POST(request: Request, { params }: MoveRouteContext): Promise<Response> {
  const input = await readMealMutation(request, moveSlotSchema);
  if (!input.ok) return input.response;
  const slotId = pathId((await params).slotId);
  if (!slotId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("move_meal_slot", {
    p_slot_id: slotId,
    p_direction: input.data.direction,
  });
  if (error) return databaseFailure("meals.move_slot_failed", error);
  return outcomeAnswer("meals.move_slot_failed", data, { id: slotId });
}
