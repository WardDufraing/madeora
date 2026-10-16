import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { createLabelSchema } from "@/tasks/schema";

/**
 * Creates a reusable task label in the Personal space or a Home (S18): in a Home, task managers
 * only. A confusing duplicate of another label there answers 409 `duplicate-name`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, createLabelSchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task_label", {
    p_id: input.data.id,
    p_name: input.data.name,
    ...(input.data.color ? { p_color: input.data.color } : {}),
    ...(input.data.homeId ? { p_home_id: input.data.homeId } : {}),
  });
  if (error) return databaseFailure("tasks.label_create_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.label_create_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision,
  });
}
