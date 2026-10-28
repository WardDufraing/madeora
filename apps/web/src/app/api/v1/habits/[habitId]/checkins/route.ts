import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logHabits } from "@/habits/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { completeSchema } from "@/habits/schema";
import { habitCheckinResultSchema } from "@/habits/shapes";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Completes a habit for a date: today or up to seven days back, scheduled, inside a tracking period
 * and not paused. A retry with the same id answers the same check-in. Refusals answer `409` with
 * their reason and the habit as it is now (`already-completed` also with who completed it).
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, completeSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("complete_habit", {
    p_checkin_id: body.id,
    p_habit_id: habitId,
    ...(body.onDate === null ? {} : { p_on: body.onDate }),
    ...(body.note === null ? {} : { p_note: body.note }),
    p_source: body.source,
  });
  if (error) return databaseFailure("habits.complete_failed", error);
  const result = habitCheckinResultSchema.safeParse(data);
  if (!result.success) {
    logHabits("habits.complete_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("habits.complete_failed", value.outcome, value, {
    habit: value.habit,
    checkin: value.checkin,
  });
}
