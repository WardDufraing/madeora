import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { CompletionResponse } from "@/tasks/api";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  readTaskMutation,
} from "@/tasks/route-helpers";
import { completionSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Completes or reopens a task (S18): one shared state for all its assignees. The database sets the
 * state under a lock, so of two people completing at once one is recorded as the completer and the
 * other is told who was first (`already_completed`). A retry changes nothing.
 */
export async function PUT(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, completionSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_task_completion", {
    p_task_id: id.data,
    p_completed: input.data.completed,
  });
  if (error) return databaseFailure("tasks.complete_failed", error);
  const row = data[0];
  const completedAt = row ? nullable(row.completed_at) : null;
  const body: CompletionResponse | object = row
    ? {
        outcome: row.outcome,
        completedAt,
        completedBy:
          completedAt === null
            ? null
            : { me: row.completed_by_me, member: nullable(row.completed_by_member) },
      }
    : {};
  return outcomeAnswer("tasks.complete_failed", row?.outcome, body);
}
