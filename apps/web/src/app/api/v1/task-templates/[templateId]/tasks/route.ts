import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  readTaskMutation,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { createFromTemplateSchema } from "@/tasks/schema";

interface TemplateRouteContext {
  readonly params: Promise<{ readonly templateId: string }>;
}

/**
 * Creates a task from a template's reviewed preview (S19b): the task and its whole checklist at
 * once, so a retry answers the same task. 409 template-changed (with its revision) when the template
 * changed since the preview was read; the list, labels and rights are checked again.
 */
export async function POST(request: Request, { params }: TemplateRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, createFromTemplateSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");
  const task = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task_from_template", {
    p_task_id: task.taskId,
    p_template_id: id.data,
    p_expected_template_revision: task.expectedTemplateRevision,
    p_list_id: task.listId,
    p_title: task.title,
    ...(task.description !== null ? { p_description: task.description } : {}),
    ...(task.priority !== null ? { p_priority: task.priority } : {}),
    p_label_ids: task.labelIds,
    p_subtasks: task.subtasks,
    ...(task.startDate !== null ? { p_start_date: task.startDate } : {}),
    ...(task.dueDate !== null ? { p_due_date: task.dueDate } : {}),
  });
  if (error) return databaseFailure("tasks.template_task_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.template_task_failed",
    row?.outcome,
    { taskId: task.taskId, revision: row?.revision },
    { revision: row?.revision },
  );
}
