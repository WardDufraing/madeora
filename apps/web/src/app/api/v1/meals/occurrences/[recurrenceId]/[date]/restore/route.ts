import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathDate,
  pathId,
  readMealMutation,
} from "@/meals/route-helpers";

interface RestoreRouteContext {
  readonly params: Promise<{ readonly recurrenceId: string; readonly date: string }>;
}

/** Undoes a skipped occurrence, unless something was planned there meanwhile (`409 occupied`). */
export async function POST(request: Request, { params }: RestoreRouteContext): Promise<Response> {
  const input = await readMealMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const { recurrenceId, date } = await params;
  const id = pathId(recurrenceId);
  const on = pathDate(date);
  if (!id || !on) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("restore_meal_occurrence", {
    p_recurrence_id: id,
    p_on: on,
  });
  if (error) return databaseFailure("meals.restore_occurrence_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.restore_occurrence_failed",
    row?.outcome,
    { recurrenceId: id, date: on },
    { occupied: row?.occupied },
  );
}
