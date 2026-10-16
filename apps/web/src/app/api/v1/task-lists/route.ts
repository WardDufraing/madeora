import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, json, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { createListSchema, listOrderSchema } from "@/tasks/schema";

/**
 * Creates a task list in the Personal space or a Home (S18): in a Home, task managers only. A name
 * that is a confusing duplicate of another list there answers 409 `duplicate-name`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, createListSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task_list", {
    p_id: input.data.id,
    p_name: input.data.name,
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
  });
  if (error) return databaseFailure("tasks.list_create_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.list_create_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision,
  });
}

/** Puts the context's lists in the given order (S18): task managers only. */
export async function PUT(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, listOrderSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reorder_task_lists", {
    p_list_ids: input.data.ids,
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
  });
  if (error) return databaseFailure("tasks.list_order_failed", error);
  return data === "saved" ? json(200, {}) : outcomeAnswer("tasks.list_order_failed", data, {});
}
