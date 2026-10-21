import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import type { AttachmentScopeImpact, TaskAttachmentView } from "./api";
import { logTasks } from "./log";

/**
 * Task attachments read with the viewer's own session (S19c). The database decides visibility (the
 * task's context) and the rights it reports; nothing here widens them.
 */

const person = z.object({ me: z.boolean(), member: z.uuid().nullable() });
const viewSchema = z.object({
  canAdd: z.boolean(),
  canChangeSeries: z.boolean(),
  limit: z.number().int(),
  attachments: z.array(
    z.object({
      id: z.uuid(),
      fileId: z.uuid(),
      name: z.string(),
      contentType: z.string(),
      size: z.number().int(),
      fromSeries: z.boolean(),
      seriesActive: z.boolean(),
      addedAt: z.string(),
      addedBy: person,
      canRemove: z.boolean(),
    }),
  ),
});

export const impactSchema = z.object({
  scope: z.enum(["following", "series"]),
  changed: z.number().int(),
  kept: z.number().int(),
  full: z.number().int(),
  completed: z.number().int(),
});

export type AttachmentRead =
  | { readonly status: "ok"; readonly value: TaskAttachmentView }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/** A task's attachments, or not-found when the task is missing or not the viewer's to see. */
export async function listTaskAttachments(taskId: string): Promise<AttachmentRead> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_task_attachments", { p_task_id: taskId });
  if (error) {
    if (error.code === "42501" || error.code === "22023" || error.code === "22P02") {
      return { status: "not-found" };
    }
    logTasks("tasks.attachments_failed", error.code);
    return { status: "unavailable" };
  }
  if (data === null) return { status: "not-found" };
  const parsed = viewSchema.safeParse(data);
  if (!parsed.success) {
    logTasks("tasks.attachments_unexpected", undefined);
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

/** The impact JSON of a series-wide change, or null. */
export function readImpact(value: unknown): AttachmentScopeImpact | null {
  const parsed = impactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
