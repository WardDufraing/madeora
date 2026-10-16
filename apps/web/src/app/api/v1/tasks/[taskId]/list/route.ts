import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { moveTaskSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Moves a task to another active list of the same Personal space or Home (S18), keeping everything
 * else about it. A deleted, archived or foreign list answers 409 `list-unavailable`.
 */
export async function PUT(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, moveTaskSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("move_task", {
    p_task_id: id.data,
    p_expected_revision: input.data.expectedRevision,
    p_list_id: input.data.listId,
  });
  if (error) return databaseFailure("tasks.move_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.move_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}
