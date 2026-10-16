import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
} from "@/tasks/route-helpers";
import { updateSubtaskSchema } from "@/tasks/schema";

interface SubtaskRouteContext {
  readonly params: Promise<{ readonly subtaskId: string }>;
}

const emptySchema = z.strictObject({});

/**
 * Renames a subtask (`{ expectedRevision, title }`) or ticks it (`{ completed }`) (S18). Ticking
 * sets a state, so a repeated request changes nothing; it never completes the parent task.
 */
export async function PATCH(request: Request, { params }: SubtaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, updateSubtaskSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).subtaskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const change = input.data;
  const { data, error } =
    "completed" in change
      ? await supabase.rpc("set_subtask_completion", {
          p_id: id.data,
          p_completed: change.completed,
        })
      : await supabase.rpc("rename_subtask", {
          p_id: id.data,
          p_expected_revision: change.expectedRevision,
          p_title: change.title,
        });
  if (error) return databaseFailure("tasks.subtask_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.subtask_update_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}

/** Removes a subtask (S18); the page confirms first. */
export async function DELETE(request: Request, { params }: SubtaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, emptySchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).subtaskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_subtask", { p_id: id.data });
  if (error) return databaseFailure("tasks.subtask_delete_failed", error);
  return data === "deleted"
    ? json(200, {})
    : outcomeAnswer("tasks.subtask_delete_failed", data, {});
}
