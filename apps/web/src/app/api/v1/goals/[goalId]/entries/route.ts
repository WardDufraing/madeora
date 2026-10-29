import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readGoalEntries } from "@/goals/data";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  pathId,
  readAnswer,
  readGoalMutation,
  readGoalQuery,
} from "@/goals/route-helpers";
import { addEntrySchema, pageQuerySchema } from "@/goals/schema";
import { goalEntryResultSchema } from "@/goals/shapes";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/**
 * Records progress on a measurable goal: adds an amount, or (goal managers) sets the total from the
 * total they saw (`409 stale` when it moved meanwhile, never overwriting someone's contribution). A
 * retry with the same id answers the same entry. An achieved goal answers `409 achieved`.
 */
export async function POST(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, addEntrySchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_goal_entry", {
    p_id: body.id,
    p_goal_id: goalId,
    p_mode: body.mode,
    p_quantity: body.quantity,
    ...(body.note === null ? {} : { p_note: body.note }),
    p_source: body.source,
    ...(body.expectedTotal === null ? {} : { p_expected_total: body.expectedTotal }),
  });
  if (error) return databaseFailure("goals.entry_failed", error);
  const result = goalEntryResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.entry_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  // Here "achieved" is a refusal: progress waits until the goal is reopened.
  if (value.outcome === "achieved") {
    return json(409, { error: "achieved", ...(value.goal ? { goal: value.goal } : {}) });
  }
  return outcomeAnswer("goals.entry_failed", value.outcome, value, { goal: value.goal });
}

/** A page of the goal's entries, newest first, with who added what and the corrections. */
export async function GET(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const query = await readGoalQuery(request, pageQuerySchema);
  if (!query.ok) return query.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  return readAnswer(await readGoalEntries(goalId, query.data.before ?? null), "entries");
}
