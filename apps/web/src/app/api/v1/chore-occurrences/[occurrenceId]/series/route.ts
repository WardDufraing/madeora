import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  impactWithNextDates,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { assignmentArg, ruleArgs, stepsArg } from "@/chores/rpc-args";
import { seriesChangeSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Changes a recurring chore from this occurrence on (`following`: the schedule splits) or for the
 * entire series (S20, chore managers): assignment, checklist, estimate and schedule. Completed and
 * skipped occurrences never change; `dryRun` answers the same impact without changing anything.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, seriesChangeSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_chore_series", {
    p_occurrence_id: id,
    p_scope: change.scope,
    p_expected_revision: change.expectedRevision,
    p_expected_schedule_revision: change.expectedScheduleRevision,
    p_dry_run: change.dryRun,
    ...(change.assignment !== undefined ? { p_assignment: assignmentArg(change.assignment) } : {}),
    ...(change.steps !== undefined ? { p_steps: stepsArg(change.steps) } : {}),
    ...(change.minutes !== undefined
      ? { p_set_minutes: true, ...(change.minutes !== null ? { p_minutes: change.minutes } : {}) }
      : {}),
    ...(change.schedule !== undefined
      ? { p_set_schedule: true, ...ruleArgs(change.schedule) }
      : {}),
  });
  if (error) return databaseFailure("chores.series_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.series_failed",
    row?.outcome,
    {
      outcome: row?.outcome,
      impact: row ? impactWithNextDates(nullable(row.impact)) : null,
      occurrenceId: row ? nullable(row.occurrence_id) : null,
    },
    { revision },
  );
}
