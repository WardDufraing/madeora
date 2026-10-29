import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { changeTargetSchema } from "@/goals/schema";
import { goalTargetResultSchema } from "@/goals/shapes";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/**
 * Previews (`preview: true` → `{ impact }`) or changes a measurable goal's target and unit. The
 * existing numbers are never converted: a unit change on a goal with progress answers
 * `409 confirm-unit` until confirmed; on an achieved goal a target above the total answers
 * `409 confirm-status` (it reopens the achievement, kept in its history).
 */
export async function POST(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, changeTargetSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_goal_target", {
    p_id: goalId,
    p_expected_revision: body.revision,
    p_target: body.target,
    p_unit: body.unit,
    p_unit_kind: body.unitKind,
    p_dry_run: body.preview,
    p_confirm_unit: body.confirmUnit,
    p_confirm_status: body.confirmStatus,
  });
  if (error) return databaseFailure("goals.target_failed", error);
  const result = goalTargetResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.target_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("goals.target_failed", value.outcome, value, {
    revision: value.revision,
    impact: value.impact,
  });
}
