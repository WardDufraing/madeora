import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { changeScheduleSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Previews (`preview: true`) or applies a forward-only schedule change: from tomorrow at the
 * earliest, and from a later habit week's start when the old or new schedule is weekly. Past dates
 * keep the version that applied to them. A refused date answers `409 invalid-dates` with the impact.
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, changeScheduleSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_habit_schedule", {
    p_id: habitId,
    p_expected_revision: body.revision,
    p_kind: body.schedule.kind,
    ...(body.schedule.weekdays === null ? {} : { p_weekdays: body.schedule.weekdays }),
    ...(body.schedule.target === null ? {} : { p_target: body.schedule.target }),
    ...(body.effectiveOn === null ? {} : { p_effective_on: body.effectiveOn }),
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("habits.schedule_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.schedule_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row?.impact ?? null, revision: row?.revision ?? null },
    { revision: row?.revision, impact: row?.impact },
  );
}
