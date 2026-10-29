import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { achievementSchema } from "@/goals/schema";
import { goalAchievementResultSchema } from "@/goals/shapes";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/**
 * Marks a goal achieved or reopens it (with an optional reason); revision-checked. A measurable goal
 * whose total is below its target answers `409 target-not-reached`. The history keeps every
 * achievement and reopening.
 */
export async function POST(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, achievementSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_goal_achievement", {
    p_id: goalId,
    p_expected_revision: body.revision,
    p_achieved: body.achieved,
    ...(body.reason === null ? {} : { p_reason: body.reason }),
  });
  if (error) return databaseFailure("goals.achievement_failed", error);
  const result = goalAchievementResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.achievement_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("goals.achievement_failed", value.outcome, value, {
    revision: value.revision,
    goal: value.goal,
  });
}
