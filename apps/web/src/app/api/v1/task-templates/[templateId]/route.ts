import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
  requireReader,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { revisionSchema, updateTemplateSchema } from "@/tasks/schema";
import { getTaskTemplate } from "@/tasks/template-data";

interface TemplateRouteContext {
  readonly params: Promise<{ readonly templateId: string }>;
}

/** One template with its still-existing labels and how many it lost (S19b). */
export async function GET(_request: Request, { params }: TemplateRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = z.uuid().safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");
  const template = await getTaskTemplate(id.data);
  if (template.status === "not-found") return failure(404, "not-found");
  if (template.status === "unavailable") return failure(500, "failed");
  return json(200, template.value);
}

/** Saves a template if nobody changed it since `expectedRevision`; tasks made from it never change. */
export async function PATCH(request: Request, { params }: TemplateRouteContext): Promise<Response> {
  const input = await readTaskMutation(request, updateTemplateSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");
  const template = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_task_template", {
    p_id: id.data,
    p_expected_revision: template.expectedRevision,
    p_name: template.name,
    p_title: template.title,
    ...(template.description !== null ? { p_description: template.description } : {}),
    ...(template.priority !== null ? { p_priority: template.priority } : {}),
    p_label_ids: template.labelIds,
    p_subtasks: template.subtasks,
  });
  if (error) return databaseFailure("tasks.template_update_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.template_update_failed",
    row?.outcome,
    { revision: row?.revision },
    { revision: row?.revision },
  );
}

/** Deletes a template (after the person confirmed); tasks made from it stay. */
export async function DELETE(
  request: Request,
  { params }: TemplateRouteContext,
): Promise<Response> {
  const input = await readTaskMutation(request, revisionSchema);
  if (!input.ok) return input.response;
  const id = z.uuid().safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_task_template", {
    p_id: id.data,
    p_expected_revision: input.data.expectedRevision,
  });
  if (error) return databaseFailure("tasks.template_delete_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.template_delete_failed",
    row?.outcome,
    {},
    { revision: row?.revision },
  );
}
