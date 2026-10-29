import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readGoalSeries } from "@/goals/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readGoalMutation,
  requireReader,
} from "@/goals/route-helpers";
import { deleteSeriesSchema, updateSeriesSchema } from "@/goals/schema";

interface SeriesRouteContext {
  readonly params: Promise<{ readonly seriesId: string }>;
}

/** One series with its periods running now and next, target schedule and history. */
export async function GET(_request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  return readAnswer(await readGoalSeries(seriesId), "series");
}

/**
 * Edits a series' title, description, end date, (personal) timezone and advance reminder; they
 * apply to the periods created afterwards. Revision-checked; an end date before the period running
 * now answers `409 invalid-dates`.
 */
export async function PATCH(request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, updateSeriesSchema);
  if (!input.ok) return input.response;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_goal_series", {
    p_id: seriesId,
    p_expected_revision: body.revision,
    p_title: body.title,
    ...(body.description === null ? {} : { p_description: body.description }),
    ...(body.endsOn === null ? {} : { p_ends_on: body.endsOn }),
    ...(body.timeZone === null ? {} : { p_time_zone: body.timeZone }),
    ...(body.reminder === null
      ? {}
      : { p_reminder_lead_days: body.reminder.leadDays, p_reminder_at_time: body.reminder.atTime }),
  });
  if (error) return databaseFailure("goals.series_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "goals.series_update_failed",
    row?.outcome,
    { id: seriesId, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}

/** Moves a series with all its periods to the trash (revision-checked); restorable for 7 days. */
export async function DELETE(request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const input = await readGoalMutation(request, deleteSeriesSchema);
  if (!input.ok) return input.response;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_goal_series", {
    p_id: seriesId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("goals.series_delete_failed", error);
  const row = data[0];
  return outcomeAnswer("goals.series_delete_failed", row?.outcome, {
    id: seriesId,
    entryId: row?.entry_id ?? null,
  });
}
