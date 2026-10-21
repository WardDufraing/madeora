import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getChoreReminder } from "@/chores/data";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { choreReminderSchema, removeChoreReminderSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * The caller's own reminder on an occurrence (S21), with whether they may set one (an assignee),
 * the Home's timezone and how they would receive it. Nobody sees another person's reminder.
 */
export async function GET(
  _request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const view = await getChoreReminder(id);
  if (view.status === "not-found") return failure(404, "not-found");
  if (view.status === "unavailable") return failure(500, "failed");
  return json(200, view.value);
}

/**
 * Sets the caller's reminder, or with `dryRun` previews the moment it resolves to (DST cases
 * included), in the Home's timezone. Only an assignee (`409 not-assignee`) of an occurrence still
 * open (`409 occurrence-closed`); a moment already passed is refused (`409 in-past`).
 */
export async function PUT(request: Request, { params }: OccurrenceRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, choreReminderSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_chore_reminder", {
    p_occurrence_id: id,
    p_mode: change.mode,
    p_expected_revision: change.expectedRevision,
    p_dry_run: change.dryRun,
    ...(change.mode === "absolute"
      ? { p_local_at: `${change.localAt}:00` }
      : { p_days_before: change.daysBefore, p_time: change.time }),
  });
  if (error) return databaseFailure("chores.reminder_set_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.reminder_set_failed",
    row?.outcome,
    {
      outcome: row?.outcome,
      fireAt: row ? nullable(row.fire_at) : null,
      dst: row ? nullable(row.dst) : null,
      revision,
    },
    { revision },
  );
}

/** Removes the caller's reminder on an occurrence, at the revision they saw. */
export async function DELETE(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, removeChoreReminderSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_chore_reminder", {
    p_occurrence_id: id,
    p_expected_revision: input.data.expectedRevision,
  });
  if (error) return databaseFailure("chores.reminder_remove_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.reminder_remove_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
