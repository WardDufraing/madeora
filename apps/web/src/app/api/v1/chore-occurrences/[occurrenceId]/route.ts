import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getChoreOccurrence } from "@/chores/data";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import type { OccurrenceImpact } from "@/chores/api";
import { stepsArg } from "@/chores/rpc-args";
import { occurrenceChangeSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/** One occurrence with its chore, checklist, record and schedule (S20); members of its Home only. */
export async function GET(
  _request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const occurrence = await getChoreOccurrence(id);
  if (occurrence.status === "not-found") return failure(404, "not-found");
  if (occurrence.status === "unavailable") return failure(500, "failed");
  return json(200, occurrence.value);
}

/**
 * Changes this open occurrence only (S20, chore managers): due date, assignees, estimate and its own
 * checklist, or previews that with `dryRun`. Removing a ticked step needs `confirmChecklist`, and a
 * new due date that releases a claim at once (its automatic release moment passed) `confirmRelease`;
 * without it the answer is `409 needs-confirmation` with the impact. Assigning a member away on a
 * Home vacation on the due date needs `confirmAway` (S22), else `409 member-away` with `impact.away`.
 */
export async function PATCH(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, occurrenceChangeSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_chore_occurrence", {
    p_occurrence_id: id,
    p_expected_revision: change.expectedRevision,
    p_dry_run: change.dryRun,
    ...(change.dueDate !== undefined ? { p_due_date: change.dueDate } : {}),
    ...(change.assigneeIds !== undefined ? { p_assignee_ids: change.assigneeIds } : {}),
    ...(change.minutes !== undefined
      ? { p_set_minutes: true, ...(change.minutes !== null ? { p_minutes: change.minutes } : {}) }
      : {}),
    ...(change.steps !== undefined ? { p_steps: stepsArg(change.steps) } : {}),
    ...(change.confirmChecklist ? { p_confirm_checklist: true } : {}),
    ...(change.confirmRelease ? { p_confirm_release: true } : {}),
    ...(change.confirmAway ? { p_confirm_away: true } : {}),
  });
  if (error) return databaseFailure("chores.occurrence_update_failed", error);
  const row = data[0];
  const impact = row ? (nullable(row.impact) as OccurrenceImpact | null) : null;
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.occurrence_update_failed",
    row?.outcome,
    { outcome: row?.outcome, impact, revision },
    { revision, impact: impact ?? undefined },
  );
}
