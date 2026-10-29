import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { quickAddsSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** Replaces the quick-add presets of the numeric tracking in effect (habit managers). */
export async function PUT(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, quickAddsSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_habit_quick_adds", {
    p_id: habitId,
    p_expected_revision: body.revision,
    p_quick_adds: body.quickAdds,
  });
  if (error) return databaseFailure("habits.quick_adds_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.quick_adds_failed",
    row?.outcome,
    { revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
