import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { revisionSchema, updateListSchema } from "@/tasks/schema";

interface ListRouteContext {
  readonly params: Promise<{ readonly listId: string }>;
}

/**
 * Renames, archives or unarchives a list (S18): task managers only. Archiving a list that still has
 * open tasks answers 409 `has-open-tasks` with their count (the impact review: move, complete or
 * delete them first), so no active task is hidden silently.
 */
export async function PATCH(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, updateListSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).listId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_task_list", {
    p_list_id: id.data,
    p_expected_revision: input.data.expectedRevision,
    p_name: input.data.name,
    p_archived: input.data.archived,
  });
  if (error) return databaseFailure("tasks.list_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.list_update_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision, count: row?.open_tasks },
  );
}

/**
 * Moves an empty list to the trash (S18, S16): task managers only. A list that still holds active
 * tasks answers 409 `has-tasks` with their count.
 */
export async function DELETE(request: Request, { params }: ListRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).listId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_task_list", {
    p_list_id: id.data,
    p_expected_revision: input.data.expectedRevision,
  });
  if (error) return databaseFailure("tasks.list_delete_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.list_delete_failed",
    row?.outcome,
    { trashEntryId: row?.entry_id },
    { count: row?.active_tasks },
  );
}
