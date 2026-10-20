import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { personalToday } from "@/tasks/data";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  readTaskMutation,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { seriesChangeSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Changes this and following occurrences, or the entire series, from one of its occurrences (S19):
 * its content, list, assignees and schedule. Completed occurrences and ones changed on their own
 * stay as they are. `dryRun` answers the impact without changing anything (the impact review);
 * the change itself answers the same impact, the series' new revision and the occurrence to show
 * (this one, or the next open one when the new schedule removed it). The series' creator or a task
 * manager; assignees need a task manager.
 */
export async function POST(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, seriesChangeSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const change = input.data;
  const content = change.content;
  const schedule = change.schedule;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_task_series", {
    p_task_id: id.data,
    p_scope: change.scope,
    p_expected_task_revision: change.expectedTaskRevision,
    p_expected_series_revision: change.expectedSeriesRevision,
    p_dry_run: change.dryRun,
    ...(content
      ? {
          p_set_content: true,
          p_title: content.title,
          ...(content.description !== null ? { p_description: content.description } : {}),
          ...(content.priority !== null ? { p_priority: content.priority } : {}),
          p_label_ids: content.labelIds,
          ...(content.startOffset !== null ? { p_start_offset: content.startOffset } : {}),
          p_copy_subtasks: content.copySubtasks,
        }
      : {}),
    ...(change.listId !== undefined ? { p_list_id: change.listId } : {}),
    ...(change.assigneeIds !== undefined ? { p_assignee_ids: change.assigneeIds } : {}),
    ...(schedule
      ? {
          p_set_schedule: true,
          p_frequency: schedule.frequency,
          p_interval: schedule.interval,
          ...(schedule.weekdays !== null ? { p_weekdays: schedule.weekdays } : {}),
          p_starts_on: schedule.startsOn,
          ...(schedule.endsOn !== null ? { p_ends_on: schedule.endsOn } : {}),
          ...(schedule.count !== null ? { p_max_count: schedule.count } : {}),
        }
      : {}),
    p_today: await personalToday(),
  });
  if (error) return databaseFailure("tasks.series_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.series_update_failed",
    row?.outcome,
    {
      outcome: row?.outcome,
      impact: row?.impact,
      revision: row?.revision,
      taskId: row?.task_id ?? null,
    },
    { revision: row?.revision },
  );
}
