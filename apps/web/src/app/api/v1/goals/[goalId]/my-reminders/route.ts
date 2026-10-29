import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { myRemindersSchema } from "@/goals/schema";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/** Turns a Home goal's deadline reminders on or off for the signed-in person only. */
export async function PUT(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, myRemindersSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_my_goal_reminders", {
    p_id: goalId,
    p_enabled: input.data.enabled,
  });
  if (error) return databaseFailure("goals.my_reminders_failed", error);
  return outcomeAnswer("goals.my_reminders_failed", data, { enabled: input.data.enabled });
}
