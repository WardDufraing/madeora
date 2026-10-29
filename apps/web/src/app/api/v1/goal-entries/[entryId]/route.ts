import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { updateEntrySchema } from "@/goals/schema";
import { goalEntryResultSchema } from "@/goals/shapes";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

/**
 * Corrects a goal entry: reverses it (the contributor's own contribution, or any entry for goal
 * managers) or amends its quantity (goal managers), with an optional reason. The entry and every
 * correction stay in the history; a change that would take the total below 0 answers
 * `409 negative-total`.
 */
export async function PATCH(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, updateEntrySchema);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_goal_entry", {
    p_id: entryId,
    p_action: body.action,
    ...(body.quantity === null ? {} : { p_quantity: body.quantity }),
    ...(body.reason === null ? {} : { p_reason: body.reason }),
  });
  if (error) return databaseFailure("goals.correction_failed", error);
  const result = goalEntryResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.correction_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("goals.correction_failed", value.outcome, value, { goal: value.goal });
}
