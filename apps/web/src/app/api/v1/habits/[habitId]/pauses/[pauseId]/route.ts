import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { updatePauseSchema } from "@/habits/schema";

interface PauseRouteContext {
  readonly params: Promise<{ readonly habitId: string; readonly pauseId: string }>;
}

/**
 * Resumes a current pause now, or moves its resume date to tomorrow or later (or clears it: until
 * resumed). Previews with `preview: true`; a pause that already ended answers `409 pause-ended`.
 */
export async function PATCH(request: Request, { params }: PauseRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, updatePauseSchema);
  if (!input.ok) return input.response;
  const path = await params;
  const habitId = pathId(path.habitId);
  const pauseId = pathId(path.pauseId);
  if (!habitId || !pauseId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_habit_pause", {
    p_pause_id: pauseId,
    p_expected_revision: body.revision,
    p_action: body.action,
    ...(body.resumesOn === null ? {} : { p_resumes_on: body.resumesOn }),
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("habits.pause_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.pause_update_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row?.impact ?? null, revision: row?.revision ?? null },
    { revision: row?.revision, impact: row?.impact },
  );
}
