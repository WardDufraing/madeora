import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readGoalMutation,
} from "@/goals/route-helpers";
import { seriesTargetSchema } from "@/goals/schema";
import { goalSeriesTargetResultSchema } from "@/goals/shapes";

interface SeriesRouteContext {
  readonly params: Promise<{ readonly seriesId: string }>;
}

/**
 * Previews (`preview: true` → `{ impact }`) or changes a measurable series' target and unit from a
 * period on: the period running now or a later one (`409 invalid-period` otherwise). Past periods
 * keep theirs. On the running period, a unit change with progress answers `409 confirm-unit` and a
 * change that flips "target reached" `409 confirm-status`, each with the impact, until confirmed.
 */
export async function POST(request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, seriesTargetSchema);
  if (!input.ok) return input.response;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_goal_series_target", {
    p_id: seriesId,
    p_expected_revision: body.revision,
    p_effective_from: body.effectiveFrom,
    p_target: body.target,
    p_unit: body.unit,
    p_unit_kind: body.unitKind,
    p_dry_run: body.preview,
    p_confirm_unit: body.confirmUnit,
    p_confirm_status: body.confirmStatus,
  });
  if (error) return databaseFailure("goals.series_target_failed", error);
  const result = goalSeriesTargetResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.series_target_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("goals.series_target_failed", value.outcome, value, {
    revision: value.revision,
    impact: value.impact,
  });
}
