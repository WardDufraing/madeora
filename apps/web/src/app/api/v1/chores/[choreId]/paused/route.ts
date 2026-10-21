import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  impactWithNextDates,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { pausedSchema } from "@/chores/schema";

interface ChoreRouteContext {
  readonly params: Promise<{ readonly choreId: string }>;
}

/**
 * Pauses a recurring chore from today until a date (inclusive) or indefinitely, or resumes it (S20,
 * chore managers), or previews that with `dryRun`. No occurrence is created for a paused date, and
 * none later for it.
 */
export async function PUT(request: Request, { params }: ChoreRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, pausedSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).choreId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_chore_paused", {
    p_chore_id: id,
    p_expected_schedule_revision: change.expectedScheduleRevision,
    p_paused: change.paused,
    ...(change.until !== null ? { p_until: change.until } : {}),
    p_dry_run: change.dryRun,
  });
  if (error) return databaseFailure("chores.pause_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.pause_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row ? impactWithNextDates(nullable(row.impact)) : null },
    { revision },
  );
}
