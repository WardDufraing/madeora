import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logHabits } from "@/habits/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { updateContributionSchema } from "@/habits/schema";
import { habitContributionResultSchema } from "@/habits/shapes";

interface ContributionRouteContext {
  readonly params: Promise<{ readonly contributionId: string }>;
}

/**
 * Undoes a contribution (`undo`: the person's own, within seven days) or corrects one (`void` or
 * `amend` with a new quantity: habit managers, any date). Nothing is deleted; the day's completion is
 * recomputed in the same transaction.
 */
export async function PATCH(
  request: Request,
  { params }: ContributionRouteContext,
): Promise<Response> {
  const input = await readHabitMutation(request, updateContributionSchema);
  if (!input.ok) return input.response;
  const contributionId = pathId((await params).contributionId);
  if (!contributionId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_habit_contribution", {
    p_id: contributionId,
    p_action: body.action,
    ...(body.quantity === null ? {} : { p_quantity: body.quantity }),
    ...(body.reason === null ? {} : { p_reason: body.reason }),
  });
  if (error) return databaseFailure("habits.contribution_update_failed", error);
  const result = habitContributionResultSchema.safeParse(data);
  if (!result.success) {
    logHabits("habits.contribution_update_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("habits.contribution_update_failed", value.outcome, value, {
    habit: value.habit,
  });
}
