import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listTasks } from "@/tasks/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
  requireReader,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { createTaskSchema, taskQuerySchema } from "@/tasks/schema";

/**
 * One page of tasks (S18), for "Show more" after the first server-rendered page: the same filters as
 * the page's search parameters, at most 50 rows of small fields, with the filtered total.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z
    .uuid()
    .optional()
    .safeParse(params.get("homeId") ?? undefined);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    if (key === "homeId") continue;
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : (values[0] ?? "");
  }
  const query = taskQuerySchema.safeParse(raw);
  if (!homeId.success || !query.success) return failure(400, "invalid");
  const page = await listTasks(homeId.data ?? null, query.data);
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}

/**
 * Creates a task in an active list of the Personal space or a Home (S18). Any current member may
 * create a Home task; choosing assignees needs a task manager. The id comes from the client, so a
 * retry returns the same task instead of a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, createTaskSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const task = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task", {
    p_id: task.id,
    p_list_id: task.listId,
    p_title: task.title,
    ...(task.description !== null ? { p_description: task.description } : {}),
    ...(task.startDate !== null ? { p_start_date: task.startDate } : {}),
    ...(task.dueDate !== null ? { p_due_date: task.dueDate } : {}),
    ...(task.priority !== null ? { p_priority: task.priority } : {}),
    p_label_ids: task.labelIds,
    p_assignee_ids: task.assigneeIds,
    ...(task.homeId ? { p_home_id: task.homeId } : {}),
  });
  if (error) return databaseFailure("tasks.create_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.create_failed", row?.outcome, {
    id: task.id,
    revision: row?.revision,
  });
}
