import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logHabits } from "@/habits/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { undoSchema } from "@/habits/schema";
import { habitCheckinResultSchema } from "@/habits/shapes";

interface CheckinRouteContext {
  readonly params: Promise<{ readonly checkinId: string }>;
}

/**
 * Undoes a check-in: the person's own within the backdating window, or any as a habit manager (a
 * correction, with an optional reason). The check-in is kept as undone; streaks recalculate.
 */
export async function POST(request: Request, { params }: CheckinRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, undoSchema);
  if (!input.ok) return input.response;
  const checkinId = pathId((await params).checkinId);
  if (!checkinId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("undo_habit_checkin", {
    p_checkin_id: checkinId,
    ...(input.data.reason === null ? {} : { p_reason: input.data.reason }),
  });
  if (error) return databaseFailure("habits.undo_failed", error);
  const result = habitCheckinResultSchema.safeParse(data);
  if (!result.success) {
    logHabits("habits.undo_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("habits.undo_failed", value.outcome, value, {
    habit: value.habit,
    checkin: value.checkin,
  });
}
