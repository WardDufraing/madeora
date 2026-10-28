import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { noteSchema } from "@/habits/schema";

interface CheckinRouteContext {
  readonly params: Promise<{ readonly checkinId: string }>;
}

/** Adds, edits or removes (empty) the note of the person's own active check-in. */
export async function PATCH(request: Request, { params }: CheckinRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, noteSchema);
  if (!input.ok) return input.response;
  const checkinId = pathId((await params).checkinId);
  if (!checkinId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_habit_checkin_note", {
    p_checkin_id: checkinId,
    p_expected_revision: body.revision,
    ...(body.note === null ? {} : { p_note: body.note }),
  });
  if (error) return databaseFailure("habits.note_failed", error);
  const row = data[0];
  // An undone check-in takes no note: answered like one that changed since it was read.
  const outcome = row?.outcome === "undone" ? "already_undone" : row?.outcome;
  return outcomeAnswer(
    "habits.note_failed",
    outcome,
    { revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
