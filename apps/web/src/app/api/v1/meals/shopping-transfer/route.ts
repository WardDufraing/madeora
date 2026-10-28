import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { previewMealTransfer } from "@/meals/data";
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
import { transferQuerySchema, transferSchema } from "@/meals/schema";

const resultsSchema = z.array(z.object({ id: z.uuid(), outcome: z.string() }));

/**
 * The planned meals of a date range (at most 31 days) with their recipes' ingredients, the token a
 * transfer sends back, and the context's lists the person may add to.
 */
export async function GET(request: Request): Promise<Response> {
  const query = await readMealQuery(request, transferQuerySchema);
  if (!query.ok) return query.response;
  const { homeId, from, to } = query.data;
  return readAnswer(await previewMealTransfer(homeId ?? null, from, to), "preview");
}

/**
 * Adds the reviewed ingredient rows to a shopping list of the same context as ordinary items, each
 * under its client id (a retry with the same transfer id answers each row again). A plan that
 * changed since the preview answers `409 stale` and adds nothing.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readMealMutation(request, transferSchema, LARGE_BODY_BYTES);
  if (!input.ok) return input.response;
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("transfer_meal_ingredients", {
    p_id: body.id,
    p_from: body.from,
    p_to: body.to,
    p_list_id: body.listId,
    p_token: body.token,
    p_items: body.items,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
  });
  if (error) return databaseFailure("meals.transfer_failed", error);
  const row = data[0];
  if (row?.outcome !== "done") return outcomeAnswer("meals.transfer_failed", row?.outcome, {});
  const results = resultsSchema.safeParse(row.results);
  if (!results.success) {
    logMeals("meals.transfer_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  return json(200, { results: results.data });
}
