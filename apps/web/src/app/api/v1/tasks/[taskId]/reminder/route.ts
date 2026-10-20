import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { personalTimeZone, getTaskReminder } from "@/tasks/reminder-data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
  requireReader,
} from "@/tasks/route-helpers";
import { removeReminderSchema, setReminderSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * A task's reminder (S19b) with what the editor shows: the reminder, the series' reminder for an
 * occurrence, who is reminded, what the person may change and how they would receive it.
 */
export async function GET(_request: Request, { params }: TaskRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const view = await getTaskReminder(id.data);
  if (view.status === "not-found") return failure(404, "not-found");
  if (view.status === "unavailable") return failure(500, "failed");
  return json(200, view.value);
}

/**
 * Sets a reminder, or with `dryRun` previews it: the time it resolves to (DST cases included) and,
 * for following or all occurrences, which ones change. The server resolves the zone: the Home's,
 * or the person's own for the Personal space. A time already passed is refused (409 in-past), as
 * is a relative reminder without a due date (409 needs-due-date) or one on a completed task.
 */
export async function PUT(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, setReminderSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_task_reminder", {
    p_task_id: id.data,
    p_scope: change.scope,
    p_mode: change.mode,
    p_expected_revision: change.expectedRevision,
    ...(change.mode === "absolute"
      ? { p_local_at: `${change.localAt}:00` }
      : { p_days_before: change.daysBefore, p_time: change.time }),
    p_time_zone: await personalTimeZone(),
    ...(change.expectedSeriesRevision !== null
      ? { p_expected_series_revision: change.expectedSeriesRevision }
      : {}),
    p_dry_run: change.dryRun,
  });
  if (error) return databaseFailure("tasks.reminder_set_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.reminder_set_failed",
    row?.outcome,
    {
      outcome: row?.outcome,
      fireAt: row?.fire_at ?? null,
      dst: row?.dst ?? null,
      impact: row?.impact ?? null,
      revision: row?.revision ?? null,
    },
    { revision: row?.revision },
  );
}

/** Removes a reminder, or with `dryRun` previews which occurrences lose theirs. */
export async function DELETE(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, removeReminderSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("remove_task_reminder", {
    p_task_id: id.data,
    p_scope: change.scope,
    p_expected_revision: change.expectedRevision,
    ...(change.expectedSeriesRevision !== null
      ? { p_expected_series_revision: change.expectedSeriesRevision }
      : {}),
    p_dry_run: change.dryRun,
  });
  if (error) return databaseFailure("tasks.reminder_remove_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.reminder_remove_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row?.impact ?? null, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
