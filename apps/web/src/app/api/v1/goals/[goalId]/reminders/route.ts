import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { remindersSchema } from "@/goals/schema";
import { goalRemindersResultSchema } from "@/goals/shapes";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/**
 * Sets a goal's deadline reminders (goal managers), from the reminder revision as read. With
 * `preview: true` answers the moments without saving, each with whether it already passed (a passed
 * moment is skipped, never sent late). Without a deadline answers `409 no-deadline`.
 */
export async function PUT(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, remindersSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_goal_reminders", {
    p_id: goalId,
    p_expected_revision: body.expectedRevision,
    p_enabled: body.enabled,
    ...(body.leadDays === null ? {} : { p_lead_days: body.leadDays }),
    ...(body.overdueDays === null ? {} : { p_overdue_days: body.overdueDays }),
    p_at_time: body.atTime,
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("goals.reminders_failed", error);
  const result = goalRemindersResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.reminders_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("goals.reminders_failed", value.outcome, value, {
    revision: value.revision,
  });
}
