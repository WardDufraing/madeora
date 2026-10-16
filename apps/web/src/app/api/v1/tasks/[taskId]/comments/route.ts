import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listTaskComments } from "@/tasks/data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
  requireReader,
} from "@/tasks/route-helpers";
import { addCommentSchema, TASK_LIMITS } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

const offsetSchema = z.coerce.number().int().min(0).max(TASK_LIMITS.maxOffset).default(0);

/** A page of a task's comments, oldest first (S18). A task the person cannot see gives none. */
export async function GET(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = z.uuid().safeParse((await params).taskId);
  const offset = offsetSchema.safeParse(
    new URL(request.url).searchParams.get("offset") ?? undefined,
  );
  if (!id.success) return failure(404, "not-found");
  if (!offset.success) return failure(400, "invalid");
  const page = await listTaskComments(id.data, offset.data);
  if (page.status === "not-found") return failure(404, "not-found");
  if (page.status === "unavailable") return failure(500, "failed");
  return json(200, page.value);
}

/**
 * Adds a plain-text comment (S18): any member who can see the task. The id comes from the client,
 * so a send that is retried after a lost answer adds the comment once.
 */
export async function POST(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, addCommentSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("add_task_comment", {
    p_id: input.data.id,
    p_task_id: id.data,
    p_body: input.data.body,
  });
  if (error) return databaseFailure("tasks.comment_add_failed", error);
  const row = data[0];
  return outcomeAnswer("tasks.comment_add_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision,
  });
}
