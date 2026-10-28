import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  contentArgs,
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readMealMutation,
} from "@/meals/route-helpers";
import { deleteEntrySchema, updateEntrySchema } from "@/meals/schema";

interface EntryRouteContext {
  readonly params: Promise<{ readonly entryId: string }>;
}

/**
 * Edits or moves a meal (revision-checked). A recipe meal sent with neither a recipe nor a title
 * keeps its recipe, also one the person can no longer see. A taken destination answers `409
 * occupied`, replaced only with its `replaceKey`.
 */
export async function PATCH(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readMealMutation(request, updateEntrySchema);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_meal_entry", {
    p_id: entryId,
    p_expected_revision: body.revision,
    p_on: body.date,
    p_slot_id: body.slotId,
    ...contentArgs(body),
    ...(body.replace === null ? {} : { p_replace: body.replace }),
  });
  if (error) return databaseFailure("meals.update_entry_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "meals.update_entry_failed",
    row?.outcome,
    { id: entryId, revision: row?.revision ?? null },
    { revision: row?.revision, occupied: row?.occupied },
  );
}

/** Moves a meal to the trash (revision-checked); restorable for 7 days while its slot is free. */
export async function DELETE(request: Request, { params }: EntryRouteContext): Promise<Response> {
  const input = await readMealMutation(request, deleteEntrySchema);
  if (!input.ok) return input.response;
  const entryId = pathId((await params).entryId);
  if (!entryId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_meal_entry", {
    p_id: entryId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("meals.delete_entry_failed", error);
  const row = data[0];
  return outcomeAnswer("meals.delete_entry_failed", row?.outcome, {
    id: entryId,
    entryId: row?.entry_id ?? null,
  });
}
