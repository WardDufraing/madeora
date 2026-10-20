import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { seriesDeleteSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Moves this and following open occurrences, or every open occurrence of the series, to the trash as
 * one entry and ends the schedule there (S19, S16). Completed occurrences stay. `dryRun` answers the
 * impact only. The series' creator or a task manager. (A single occurrence is deleted with
 * `DELETE /api/v1/tasks/:id`, like any task.)
 */
export async function POST(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, seriesDeleteSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_task_series", {
    p_task_id: id.data,
    p_scope: input.data.scope,
    p_expected_series_revision: input.data.expectedSeriesRevision,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("tasks.series_delete_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.series_delete_failed", row?.outcome, {
    outcome: row?.outcome,
    impact: row?.impact,
    trashEntryId: row?.entry_id ?? null,
  });
}
