import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readGoal } from "@/goals/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readGoalMutation,
  requireReader,
} from "@/goals/route-helpers";
import { deleteGoalSchema, updateGoalSchema } from "@/goals/schema";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/** One goal with everything its page shows; not found when the person may not see it. */
export async function GET(_request: Request, { params }: GoalRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  return readAnswer(await readGoal(goalId), "goal");
}

/**
 * Edits a goal's title, description, deadline and (personal goals) timezone; revision-checked. A
 * new deadline must be today or later (`409 invalid-dates`); removing it turns its reminders off.
 */
export async function PATCH(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, updateGoalSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_goal", {
    p_id: goalId,
    p_expected_revision: body.revision,
    p_title: body.title,
    ...(body.description === null ? {} : { p_description: body.description }),
    ...(body.deadline === null ? {} : { p_deadline: body.deadline }),
    ...(body.timeZone === null ? {} : { p_time_zone: body.timeZone }),
  });
  if (error) return databaseFailure("goals.update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "goals.update_failed",
    row?.outcome,
    { id: goalId, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}

/** Moves a goal to the trash (revision-checked); restorable unchanged for 7 days. */
export async function DELETE(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, deleteGoalSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_goal", {
    p_id: goalId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("goals.delete_failed", error);
  const row = data[0];
  return outcomeAnswer("goals.delete_failed", row?.outcome, {
    id: goalId,
    entryId: row?.entry_id ?? null,
  });
}
