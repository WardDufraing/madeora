import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { remindersSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** Sets a habit's reminders (up to three times on chosen weekdays) or turns them off. */
export async function PUT(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, remindersSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_habit_reminders", {
    p_id: habitId,
    p_expected_revision: body.expectedRevision,
    p_enabled: body.enabled,
    ...(body.times === null ? {} : { p_times: body.times }),
    ...(body.weekdays === null ? {} : { p_weekdays: body.weekdays }),
  });
  if (error) return databaseFailure("habits.reminders_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.reminders_failed",
    row?.outcome,
    { revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
