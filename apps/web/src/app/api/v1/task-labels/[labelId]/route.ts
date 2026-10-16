import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { revisionSchema, updateLabelSchema } from "@/tasks/schema";

interface LabelRouteContext {
  readonly params: Promise<{ readonly labelId: string }>;
}

/** Renames or recolours a label (S18): task managers only. Tasks show the new name at once. */
export async function PATCH(request: Request, { params }: LabelRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, updateLabelSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).labelId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_task_label", {
    p_label_id: id.data,
    p_expected_revision: input.data.expectedRevision,
    p_name: input.data.name,
    ...(input.data.color ? { p_color: input.data.color } : {}),
  });
  if (error) return databaseFailure("tasks.label_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.label_update_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}

/**
 * Removes a label after the impact review (S18): it is detached from its tasks, which stay. A label
 * changed since the review answers 409 `conflict`.
 */
export async function DELETE(request: Request, { params }: LabelRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).labelId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_task_label", {
    p_label_id: id.data,
    p_expected_revision: input.data.expectedRevision,
  });
  if (error) return databaseFailure("tasks.label_delete_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.label_delete_failed", row?.outcome, { detached: row?.detached });
}
