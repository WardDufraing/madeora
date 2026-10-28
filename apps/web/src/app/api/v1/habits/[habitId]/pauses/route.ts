import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { pauseSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/** Previews or starts a manual pause from today, until a resume date or until resumed. */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, pauseSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("pause_habit", {
    p_id: habitId,
    p_expected_revision: body.revision,
    ...(body.resumesOn === null ? {} : { p_resumes_on: body.resumesOn }),
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("habits.pause_failed", error);
  const row = data[0];
  const answer = {
    outcome: row?.outcome,
    impact: row?.impact ?? null,
    revision: row?.revision ?? null,
  };
  if (row?.outcome === "paused") return json(200, answer);
  return outcomeAnswer("habits.pause_failed", row?.outcome, answer, {
    revision: row?.revision,
    impact: row?.impact,
  });
}
