import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { previewMealSeries, todayArg } from "@/meals/data";
import {
  contentArgs,
  databaseFailure,
  outcomeAnswer,
  readMealMutation,
  seriesPreviewAnswer,
} from "@/meals/route-helpers";
import { seriesCreateSchema, seriesPreviewSchema } from "@/meals/schema";

const seriesSchema = z.discriminatedUnion("action", [seriesPreviewSchema, seriesCreateSchema]);

/**
 * `preview`: a new repeating meal's next dates and its collisions over the coming year, with a
 * token. `create`: starts it with that token and a `skip` or `replace` choice per collision; a
 * token that no longer matches answers `409 conflicts` with the current ones (nothing saved).
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readMealMutation(request, seriesSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  if (body.action === "preview") {
    const read = await previewMealSeries({
      homeId: body.homeId,
      seriesId: null,
      slotId: body.slotId,
      cadence: body.cadence,
      weekdays: body.weekdays,
      startOn: body.startOn,
      endOn: body.endOn,
    });
    return seriesPreviewAnswer(read);
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_meal_series", {
    p_id: body.id,
    p_slot_id: body.slotId,
    p_cadence: body.cadence,
    p_weekdays: [...(body.weekdays ?? [])],
    p_start_on: body.startOn,
    p_token: body.token,
    p_decisions: body.decisions,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
    ...(body.endOn ? { p_end_on: body.endOn } : {}),
    ...contentArgs(body),
    ...(await todayArg(body.homeId)),
  });
  if (error) return databaseFailure("meals.create_series_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.create_series_failed",
    row?.outcome,
    { id: body.id, revision: row?.revision ?? null },
    { collisions: row?.collisions },
  );
}
