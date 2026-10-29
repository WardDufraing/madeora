import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { dayNoteSchema, habitDateSchema } from "@/habits/schema";

interface DayNoteRouteContext {
  readonly params: Promise<{ readonly habitId: string; readonly date: string }>;
}

/** Sets, edits or removes (empty) the one note of a numeric day; the earlier text stays in its revisions. */
export async function PUT(request: Request, { params }: DayNoteRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, dayNoteSchema);
  if (!input.ok) return input.response;
  const path = await params;
  const habitId = pathId(path.habitId);
  const date = habitDateSchema.safeParse(path.date);
  if (!habitId || !date.success) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_habit_day_note", {
    p_habit_id: habitId,
    p_on: date.data,
    p_expected_revision: body.revision,
    ...(body.note === null ? {} : { p_note: body.note }),
  });
  if (error) return databaseFailure("habits.day_note_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.day_note_failed",
    row?.outcome,
    { revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
