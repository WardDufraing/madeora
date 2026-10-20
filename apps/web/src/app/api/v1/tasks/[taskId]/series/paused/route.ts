import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { personalToday } from "@/tasks/data";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { seriesPausedSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Pauses a series (no new occurrences; open ones stay) or resumes it from today, without creating
 * the dates missed while paused (S19). The series' creator or a task manager.
 */
export async function PUT(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, seriesPausedSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_task_series_paused", {
    p_task_id: id.data,
    p_paused: input.data.paused,
    p_expected_series_revision: input.data.expectedSeriesRevision,
    p_today: await personalToday(),
  });
  if (error) return databaseFailure("tasks.series_pause_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.series_pause_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}
