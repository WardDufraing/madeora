import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  contentArgs,
  databaseFailure,
  failure,
  outcomeAnswer,
  pathDate,
  pathId,
  readMealMutation,
} from "@/meals/route-helpers";
import { editOccurrenceSchema } from "@/meals/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly recurrenceId: string; readonly date: string }>;
}

async function occurrence(params: OccurrenceRouteContext["params"]) {
  const { recurrenceId, date } = await params;
  const id = pathId(recurrenceId);
  const on = pathDate(date);
  return id && on ? { id, on } : null;
}

/**
 * Edits or moves one occurrence of a repeating meal: it becomes a meal of its own (`entryId`, from
 * the client, so a retry answers `200` again) and the series continues. A taken destination answers
 * `409 occupied`.
 */
export async function PUT(request: Request, { params }: OccurrenceRouteContext): Promise<Response> {
  const input = await readMealMutation(request, editOccurrenceSchema);
  if (!input.ok) return input.response;
  const target = await occurrence(params);
  if (!target) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("edit_meal_occurrence", {
    p_recurrence_id: target.id,
    p_on: target.on,
    p_entry_id: body.entryId,
    p_new_on: body.date,
    p_slot_id: body.slotId,
    ...contentArgs(body),
    ...(body.replace === null ? {} : { p_replace: body.replace }),
  });
  if (error) return databaseFailure("meals.edit_occurrence_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.edit_occurrence_failed",
    row?.outcome,
    { id: body.entryId, revision: row?.revision ?? null },
    { occupied: row?.occupied },
  );
}

/** Skips one occurrence; the series continues. Idempotent; undone with `…/restore`. */
export async function DELETE(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readMealMutation(request, z.strictObject({}));
  if (!input.ok) return input.response;
  const target = await occurrence(params);
  if (!target) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("skip_meal_occurrence", {
    p_recurrence_id: target.id,
    p_on: target.on,
  });
  if (error) return databaseFailure("meals.skip_occurrence_failed", error);
  return outcomeAnswer("meals.skip_occurrence_failed", data, {
    recurrenceId: target.id,
    date: target.on,
  });
}
