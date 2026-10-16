import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
} from "@/tasks/route-helpers";
import { updateCommentSchema } from "@/tasks/schema";

interface CommentRouteContext {
  readonly params: Promise<{ readonly commentId: string }>;
}

const emptySchema = z.strictObject({});

/**
 * Edits the person's own comment (S18) if nobody edited it since `expectedRevision`. Someone else's
 * comment answers 403, even for the Home's Owner: moderation is not specified.
 */
export async function PATCH(request: Request, { params }: CommentRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, updateCommentSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).commentId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_task_comment", {
    p_id: id.data,
    p_expected_revision: input.data.expectedRevision,
    p_body: input.data.body,
  });
  if (error) return databaseFailure("tasks.comment_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.comment_update_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}

/** Deletes the person's own comment (S18); the page confirms first. */
export async function DELETE(request: Request, { params }: CommentRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, emptySchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).commentId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_task_comment", { p_id: id.data });
  if (error) return databaseFailure("tasks.comment_delete_failed", error);
  return data === "deleted"
    ? json(200, {})
    : outcomeAnswer("tasks.comment_delete_failed", data, {});
}
