import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { snoozeSchema } from "@/habits/schema";

interface SnoozeRouteContext {
  readonly params: Promise<{ readonly notificationId: string }>;
}

/**
 * Snoozes a habit reminder from the notification centre by 15, 30 or 60 minutes: one deferred
 * delivery per reminder, refused when it would land in quiet hours (`409 quiet-hours`) or after the
 * day or week it is for (`409 window-closed`), or when the habit no longer needs it.
 */
export async function POST(request: Request, { params }: SnoozeRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, snoozeSchema);
  if (!input.ok) return input.response;
  const notificationId = pathId((await params).notificationId);
  if (!notificationId) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("snooze_habit_reminder", {
    p_notification_id: notificationId,
    p_minutes: input.data.minutes,
  });
  if (error) return databaseFailure("habits.snooze_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "habits.snooze_failed",
    row?.outcome,
    { dueAt: row?.due_at ?? null },
    { dueAt: row?.due_at },
  );
}
