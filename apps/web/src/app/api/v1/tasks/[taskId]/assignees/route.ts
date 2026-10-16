import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { setAssigneesSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Sets a Home task's assignees (S18; spec: "the Home task-management permission"): task managers
 * only, current members of the same Home only, named by membership id. Clears the "needs
 * reassignment" flag left by a departed assignee.
 */
export async function PUT(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, setAssigneesSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_task_assignees", {
    p_task_id: id.data,
    p_expected_revision: input.data.expectedRevision,
    p_member_ids: input.data.memberIds,
  });
  if (error) return databaseFailure("tasks.assign_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.assign_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}
