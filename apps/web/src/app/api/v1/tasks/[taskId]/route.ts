import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  readTaskMutation,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { updateTaskSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

const emptySchema = z.strictObject({});

/**
 * Saves a task's content (S18): title, description, dates, priority and labels, if nobody changed
 * it since `expectedRevision` (409 otherwise, with the current revision). Its creator, its assignees
 * and task managers may; anyone else in the Home 403; a task they cannot see 404.
 */
export async function PATCH(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, updateTaskSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const task = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_task", {
    p_task_id: id.data,
    p_expected_revision: task.expectedRevision,
    p_title: task.title,
    p_label_ids: task.labelIds,
    // Left out means "none": the function clears what is not sent.
    ...(task.description !== null ? { p_description: task.description } : {}),
    ...(task.startDate !== null ? { p_start_date: task.startDate } : {}),
    ...(task.dueDate !== null ? { p_due_date: task.dueDate } : {}),
    ...(task.priority !== null ? { p_priority: task.priority } : {}),
  });
  if (error) return databaseFailure("tasks.update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.update_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}

/**
 * Moves a task to the trash with its subtasks and comments (S18, S16): restorable for 7 days. Its
 * creator or a task manager may.
 */
export async function DELETE(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, emptySchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_task", { p_task_id: id.data });
  if (error) return databaseFailure("tasks.delete_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.delete_failed", row?.outcome, { trashEntryId: row?.entry_id });
}
