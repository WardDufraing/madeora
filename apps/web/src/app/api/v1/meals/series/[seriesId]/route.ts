import { createSupabaseServerClient } from "@/auth/supabase-server";
import { previewMealSeries, todayArg } from "@/meals/data";
import {
  contentArgs,
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readMealMutation,
  seriesPreviewAnswer,
} from "@/meals/route-helpers";
import { seriesUpdateSchema } from "@/meals/schema";

interface SeriesRouteContext {
  readonly params: Promise<{ readonly seriesId: string }>;
}

/**
 * Changes a repeating meal from the revision the caller saw: `preview` (the collisions of an edit or
 * resume from a date), `editFuture` (this and later occurrences; the past is never rewritten),
 * `pause`, `resume` or `end`. Edits and resumes need the preview's token and a choice per collision.
 */
export async function PATCH(request: Request, { params }: SeriesRouteContext): Promise<Response> {
  const input = await readMealMutation(request, seriesUpdateSchema);
  if (!input.ok) return input.response;
  const seriesId = pathId((await params).seriesId);
  if (!seriesId) return failure(404, "not-found");
  const body = input.data;
  if (body.action === "preview") {
    return seriesPreviewAnswer(
      await previewMealSeries({
        homeId: body.homeId,
        seriesId,
        slotId: body.slotId,
        cadence: body.cadence,
        weekdays: body.weekdays,
        startOn: body.from,
        endOn: body.endOn,
      }),
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_meal_series", {
    p_id: seriesId,
    p_expected_revision: body.revision,
    p_action: body.action === "editFuture" ? "edit_future" : body.action,
    ...(body.action === "pause" ? {} : { p_from: body.from }),
    ...(body.action === "editFuture" || body.action === "resume"
      ? { p_token: body.token, p_decisions: body.decisions }
      : {}),
    ...(body.action === "editFuture"
      ? {
          p_slot_id: body.slotId,
          p_cadence: body.cadence,
          p_weekdays: [...(body.weekdays ?? [])],
          ...(body.endOn ? { p_end_on: body.endOn } : {}),
          ...contentArgs(body),
        }
      : {}),
    // The series' Home decides its own day in the database; this is the Personal space's.
    ...(await todayArg(null)),
  });
  if (error) return databaseFailure("meals.update_series_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.update_series_failed",
    row?.outcome,
    { id: seriesId, revision: row?.revision ?? null },
    { revision: row?.revision, collisions: row?.collisions },
  );
}
