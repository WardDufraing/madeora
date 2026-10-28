import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { reactivateSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Previews or confirms the reactivation of an Ended habit: a new tracking period from today or
 * later with a schedule and the reviewed reminders (kept, changed or turned off; never switched on
 * by itself). Confirming twice makes one period: the second answers `409 conflict`.
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, reactivateSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reactivate_habit", {
    p_id: habitId,
    p_expected_revision: body.revision,
    p_starts_on: body.startsOn,
    ...(body.endsOn === null ? {} : { p_ends_on: body.endsOn }),
    p_kind: body.schedule.kind,
    ...(body.schedule.weekdays === null ? {} : { p_weekdays: body.schedule.weekdays }),
    ...(body.schedule.target === null ? {} : { p_target: body.schedule.target }),
    p_reminder: body.reminder.mode,
    ...(body.reminder.times === null ? {} : { p_reminder_times: body.reminder.times }),
    ...(body.reminder.weekdays === null ? {} : { p_reminder_weekdays: body.reminder.weekdays }),
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("habits.reactivate_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.reactivate_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row?.impact ?? null, revision: row?.revision ?? null },
    { revision: row?.revision, impact: row?.impact },
  );
}
