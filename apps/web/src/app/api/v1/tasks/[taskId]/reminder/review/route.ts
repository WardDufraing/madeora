import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, outcomeAnswer, readTaskMutation } from "@/tasks/route-helpers";
import { reviewReminderSchema } from "@/tasks/schema";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * Settles a reminder put on hold when the task's due date changed or was removed (S19b): follow the
 * new due date, or remove it. 409 not-needed when it is no longer on hold.
 */
export async function POST(request: Request, { params }: TaskRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, reviewReminderSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).taskId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("review_task_reminder", {
    p_task_id: id.data,
    p_choice: input.data.choice,
    p_expected_revision: input.data.expectedRevision,
  });
  if (error) return databaseFailure("tasks.reminder_review_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.reminder_review_failed",
    row?.outcome,
    { outcome: row?.outcome, fireAt: row?.fire_at ?? null, revision: row?.revision ?? null },
    { revision: row?.revision },
  );
}
