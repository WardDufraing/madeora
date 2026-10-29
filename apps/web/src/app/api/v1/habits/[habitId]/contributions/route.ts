import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readHabitContributions } from "@/habits/data";
import { logHabits } from "@/habits/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readHabitMutation,
  readHabitQuery,
} from "@/habits/route-helpers";
import { addContributionSchema, contributionsQuerySchema } from "@/habits/schema";
import { habitContributionResultSchema } from "@/habits/shapes";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Adds progress to a numeric habit's day (today or up to seven days back). A retry with the same id
 * answers the same contribution. An entry in another unit of the same kind is converted exactly; one
 * that would need more than 3 decimals answers `409 precision` with the rounded `converted`.
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, addContributionSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_habit_contribution", {
    p_id: body.id,
    p_habit_id: habitId,
    p_quantity: body.quantity,
    ...(body.onDate === null ? {} : { p_on: body.onDate }),
    ...(body.enteredUnit === null ? {} : { p_entered_unit: body.enteredUnit }),
    p_source: body.source,
    ...(body.revision === null ? {} : { p_expected_revision: body.revision }),
  });
  if (error) return databaseFailure("habits.contribution_failed", error);
  const result = habitContributionResultSchema.safeParse(data);
  if (!result.success) {
    logHabits("habits.contribution_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("habits.contribution_failed", value.outcome, value, {
    habit: value.habit,
    converted: value.converted,
  });
}

/**
 * One day's contributions the person may see: their own, or every one with who added it for habit
 * managers. Members who only view see totals elsewhere, never this list.
 */
export async function GET(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const query = await readHabitQuery(request, contributionsQuerySchema);
  if (!query.ok) return query.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  return readAnswer(await readHabitContributions(habitId, query.data.on), "contributions");
}
