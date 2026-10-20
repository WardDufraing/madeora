import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import type { TaskTemplate, TaskTemplateSummary } from "./api";
import type { Read } from "./data";
import { logTasks } from "./log";
import { taskPriorities } from "./schema";

/** Server reads of task templates (S19b), with the person's own session. */

const priority = z.enum(taskPriorities).nullable().catch(null);

export async function listTaskTemplates(
  homeId: string | null,
): Promise<Read<readonly TaskTemplateSummary[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "list_task_templates",
    homeId ? { p_home_id: homeId } : {},
  );
  if (error) {
    if (error.code === "42501") return { status: "not-found" };
    logTasks("tasks.templates_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      name: row.name,
      title: row.title,
      priority: priority.parse(row.priority),
      labelCount: row.label_count,
      subtaskCount: row.subtask_count,
      revision: row.revision,
    })),
  };
}

const templateSchema = z.object({
  id: z.uuid(),
  homeId: z.uuid().nullable(),
  name: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority,
  labelIds: z.array(z.uuid()),
  omittedLabels: z.int().min(0),
  subtasks: z.array(z.string()),
  revision: z.int(),
  canManage: z.boolean(),
});

/** One template; not-found when it is missing or not the person's to see. */
export async function getTaskTemplate(id: string): Promise<Read<TaskTemplate>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_task_template", { p_id: id });
  if (error) {
    logTasks("tasks.template_read_failed", error.code);
    return { status: "unavailable" };
  }
  if (data === null) return { status: "not-found" };
  const parsed = templateSchema.safeParse(data);
  if (!parsed.success) {
    logTasks("tasks.template_read_failed", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}
