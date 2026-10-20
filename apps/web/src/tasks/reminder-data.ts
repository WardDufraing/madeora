import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getEffectiveTimeZone } from "@/preferences/server";

import type { TaskReminderView } from "./api";
import type { Read } from "./data";
import { logTasks } from "./log";

/**
 * Server reads of task reminders (S19b), with the person's own session. The Personal space uses the
 * person's effective timezone, read here on the server, never one the browser sends.
 */

const dst = z.enum(["gap", "overlap"]).nullable();
const clock = z.string().regex(/^\d{2}:\d{2}$/);

const reminderViewSchema = z.object({
  taskId: z.uuid(),
  dueDate: z.iso.date().nullable(),
  completed: z.boolean(),
  recurring: z.boolean(),
  canEdit: z.boolean(),
  canEditSeries: z.boolean(),
  timeZone: z.string().nullable(),
  reminder: z
    .object({
      // Null for a reminder switched off on one occurrence ('off').
      mode: z.enum(["absolute", "relative"]).nullable(),
      localAt: z.string().nullable(),
      daysBefore: z.int().nullable(),
      time: clock.nullable(),
      timeZone: z.string().nullable(),
      // Null while on hold ('needs_review') and when off.
      fireAt: z.string().nullable(),
      dst,
      status: z.enum(["scheduled", "needs_review", "sent", "not_sent", "off"]),
      own: z.boolean(),
      revision: z.int(),
      reviewFireAt: z.string().nullable(),
      reviewDst: dst,
    })
    .nullable(),
  seriesReminder: z
    .object({
      active: z.boolean(),
      daysBefore: z.int().nullable(),
      time: clock.nullable(),
      revision: z.int(),
    })
    .nullable(),
  recipients: z.array(z.uuid()).nullable(),
  recipientsAreAssignees: z.boolean(),
  channels: z.object({ inApp: z.boolean(), email: z.boolean() }),
});

/** The zone a reminder in the Personal space uses: the person's effective one. */
export async function personalTimeZone(): Promise<string> {
  return (await getEffectiveTimeZone()).timeZone;
}

/** A task's reminder and what its editor shows; not-found for a task the person cannot see. */
export async function getTaskReminder(taskId: string): Promise<Read<TaskReminderView>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_task_reminder", {
    p_task_id: taskId,
    p_time_zone: await personalTimeZone(),
  });
  if (error) {
    if (error.code === "42501") return { status: "not-found" };
    logTasks("tasks.reminder_read_failed", error.code);
    return { status: "unavailable" };
  }
  if (data === null) return { status: "not-found" };
  const parsed = reminderViewSchema.safeParse(data);
  if (!parsed.success) {
    logTasks("tasks.reminder_read_failed", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}
