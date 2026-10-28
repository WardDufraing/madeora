import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { setEndSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Previews or sets, changes or clears the end date of the current tracking period. An end before
 * active check-ins answers `409 checkins-after-end` with the impact.
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, setEndSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_habit_end", {
    p_id: habitId,
    p_expected_revision: body.revision,
    ...(body.endsOn === null ? {} : { p_ends_on: body.endsOn }),
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("habits.end_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.end_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row?.impact ?? null, revision: row?.revision ?? null },
    { revision: row?.revision, impact: row?.impact },
  );
}
