import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { mealCopyOutcomes } from "@/meals/api";
import { previewMealCopy } from "@/meals/data";
import { logMeals } from "@/meals/log";
import {
  databaseFailure,
  failure,
  json,
  LARGE_BODY_BYTES,
  outcomeAnswer,
  readAnswer,
  readMealMutation,
  readMealQuery,
} from "@/meals/route-helpers";
import { copyQuerySchema, copySchema } from "@/meals/schema";

const resultsSchema = z.array(
  z.object({ key: z.string(), id: z.uuid(), outcome: z.enum(mealCopyOutcomes) }),
);

/** What copying one week to another would make: each meal, what is in its place, and a token. */
export async function GET(request: Request): Promise<Response> {
  const query = await readMealQuery(request, copyQuerySchema);
  if (!query.ok) return query.response;
  const { homeId, source, destination } = query.data;
  return readAnswer(await previewMealCopy(homeId ?? null, source, destination), "preview");
}

/**
 * Copies the chosen meals of a week preview as standalone meals, each under its client id (a retry
 * answers `exists`). A preview that changed meanwhile answers `409 stale` and copies nothing; a
 * taken slot is replaced only when its row says so.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readMealMutation(request, copySchema, LARGE_BODY_BYTES);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("copy_meal_week", {
    p_source: body.source,
    p_destination: body.destination,
    p_token: body.token,
    p_rows: body.rows,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
  });
  if (error) return databaseFailure("meals.copy_week_failed", error);
  const row = data[0];
  if (row?.outcome !== "done") return outcomeAnswer("meals.copy_week_failed", row?.outcome, {});
  const results = resultsSchema.safeParse(row.results);
  if (!results.success) {
    logMeals("meals.copy_week_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  return json(200, { results: results.data });
}
