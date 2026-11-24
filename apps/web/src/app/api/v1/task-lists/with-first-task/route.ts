import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { createListWithFirstTaskSchema } from "@/tasks/schema";

/**
 * Creates a task list and its first task in one step (UX4a), for the "create a list for this task"
 * confirmation shown when there is no list yet. A list is never created without that confirmation.
 * Lists need a task manager; on any refusal neither is created. Ids come from the client, so a retry
 * answers 200 instead of making a second list or task. Answers `201 { listId, taskId, ... }`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, createListWithFirstTaskSchema);
  if (!input.ok) return input.response;
  const { homeId, list, task } = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task_list_with_task", {
    p_list_id: list.id,
    p_list_name: list.name,
    p_task_id: task.id,
    p_title: task.title,
    ...(task.description !== null ? { p_description: task.description } : {}),
    ...(task.startDate !== null ? { p_start_date: task.startDate } : {}),
    ...(task.dueDate !== null ? { p_due_date: task.dueDate } : {}),
    ...(task.priority !== null ? { p_priority: task.priority } : {}),
    p_label_ids: task.labelIds,
    p_assignee_ids: task.assigneeIds,
    ...(homeId ? { p_home_id: homeId } : {}),
  });
  if (error) return databaseFailure("tasks.list_with_task_create_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.list_with_task_create_failed", row?.outcome, {
    listId: list.id,
    taskId: task.id,
    listRevision: row?.list_revision,
    taskRevision: row?.task_revision,
  });
}
