import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { archiveSchema } from "@/goals/schema";

interface GoalRouteContext {
  readonly params: Promise<{ readonly goalId: string }>;
}

/**
 * Archives a goal (hidden from lists, widgets and reminders; everything kept) or brings it back.
 * Unarchiving past the context's goal limit answers `409 limit-reached`.
 */
export async function POST(request: Request, { params }: GoalRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, archiveSchema);
  if (!input.ok) return input.response;
  const goalId = pathId((await params).goalId);
  if (!goalId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("archive_goal", {
    p_id: goalId,
    p_expected_revision: body.revision,
    p_archived: body.archived,
  });
  if (error) return databaseFailure("goals.archive_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "goals.archive_failed",
    row?.outcome,
    { id: goalId, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
