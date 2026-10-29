import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { seriesStateSchema } from "@/goals/schema";

interface SeriesRouteContext {
  readonly params: Promise<{ readonly seriesId: string }>;
}

/**
 * Pauses (no new periods; the running one goes on), resumes (the running period is created if
 * missing, never the ones that passed) or stops a series (final: `409 stopped` afterwards).
 */
export async function POST(request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, seriesStateSchema);
  if (!input.ok) return input.response;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_goal_series_state", {
    p_id: seriesId,
    p_expected_revision: body.revision,
    p_action: body.action,
  });
  if (error) return databaseFailure("goals.series_state_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "goals.series_state_failed",
    row?.outcome,
    { id: seriesId, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
