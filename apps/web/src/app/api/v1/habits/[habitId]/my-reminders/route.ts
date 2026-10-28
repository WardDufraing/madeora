import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { myRemindersSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** Turns a Home habit's reminders on or off for the signed-in person only. */
export async function PUT(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, myRemindersSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_my_habit_reminders", {
    p_id: habitId,
    p_enabled: input.data.enabled,
  });
  if (error) return databaseFailure("habits.my_reminders_failed", error);
  return outcomeAnswer("habits.my_reminders_failed", data, { enabled: input.data.enabled });
}
