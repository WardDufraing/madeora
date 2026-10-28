import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { archiveSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Archives a habit (hidden from lists, widgets and reminders; everything kept) or brings it back.
 * Unarchiving past the context's habit limit answers `409 limit-reached`.
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, archiveSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("archive_habit", {
    p_id: habitId,
    p_expected_revision: body.revision,
    p_archived: body.archived,
  });
  if (error) return databaseFailure("habits.archive_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.archive_failed",
    row?.outcome,
    { id: habitId, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
