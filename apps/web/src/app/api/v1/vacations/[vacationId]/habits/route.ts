import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readVacationHabits } from "@/habits/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readHabitMutation,
  requireReader,
} from "@/habits/route-helpers";
import { vacationHabitSchema } from "@/habits/schema";

interface VacationRouteContext {
  readonly params: Promise<{ readonly vacationId: string }>;
}

/** The person's own active personal habits and whether each pauses during this vacation (S28). */
export async function GET(_request: Request, { params }: VacationRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const vacationId = pathId((await params).vacationId);
  if (!vacationId) return failure(404, "not-found");
  return readAnswer(await readVacationHabits(vacationId), "vacationHabits");
}

/**
 * Switches one of the person's personal habits on or off for their accepted participation: paused
 * during it from today on (days already passed never change).
 */
export async function PUT(request: Request, { params }: VacationRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, vacationHabitSchema);
  if (!input.ok) return input.response;
  const vacationId = pathId((await params).vacationId);
  if (!vacationId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_vacation_habit", {
    p_vacation_id: vacationId,
    p_habit_id: input.data.habitId,
    p_paused: input.data.paused,
  });
  if (error) return databaseFailure("habits.vacation_switch_failed", error);
  return outcomeAnswer("habits.vacation_switch_failed", data, { paused: input.data.paused });
}
