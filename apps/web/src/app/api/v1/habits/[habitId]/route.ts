import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readHabit } from "@/habits/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readAnswer,
  readHabitMutation,
  requireReader,
} from "@/habits/route-helpers";
import { deleteHabitSchema, updateHabitSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** One habit with everything its page shows; not found when the person may not see it. */
export async function GET(_request: Request, { params }: HabitRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  return readAnswer(await readHabit(habitId), "habit");
}

/** Edits a habit's name, description and (personal habits) timezone; revision-checked. */
export async function PATCH(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, updateHabitSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_habit", {
    p_id: habitId,
    p_expected_revision: body.revision,
    p_name: body.name,
    ...(body.description === null ? {} : { p_description: body.description }),
    ...(body.timeZone === null ? {} : { p_time_zone: body.timeZone }),
  });
  if (error) return databaseFailure("habits.update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.update_failed",
    row?.outcome,
    { id: habitId, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}

/** Moves a habit to the trash (revision-checked); restorable unchanged for 7 days. */
export async function DELETE(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, deleteHabitSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_habit", {
    p_id: habitId,
    p_expected_revision: input.data.revision,
  });
  if (error) return databaseFailure("habits.delete_failed", error);
  const row = data[0];
  return outcomeAnswer("habits.delete_failed", row?.outcome, {
    id: habitId,
    entryId: row?.entry_id ?? null,
  });
}
