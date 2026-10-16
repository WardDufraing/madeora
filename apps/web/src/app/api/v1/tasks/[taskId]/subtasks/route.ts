import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
} from "@/tasks/route-helpers";
import { addSubtaskSchema, subtaskOrderSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/** Adds a subtask at the end of a task's checklist (S18): whoever may edit the task. */
export async function POST(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, addSubtaskSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_subtask", {
    p_id: input.data.id,
    p_task_id: id.data,
    p_title: input.data.title,
  });
  if (error) return databaseFailure("tasks.subtask_add_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.subtask_add_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision,
  });
}

/** Puts a task's subtasks in the given order (S18). */
export async function PUT(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, subtaskOrderSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reorder_subtasks", {
    p_task_id: id.data,
    p_subtask_ids: input.data.ids,
  });
  if (error) return databaseFailure("tasks.subtask_order_failed", error);
  return data === "saved" ? json(200, {}) : outcomeAnswer("tasks.subtask_order_failed", data, {});
}
