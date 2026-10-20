import { contextSchema, createTemplateSchema } from "@/tasks/schema";
import { listTaskTemplates } from "@/tasks/template-data";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readTaskMutation,
  requireReader,
  TASK_BODY_BYTES,
} from "@/tasks/route-helpers";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/** The templates of the Personal space, or of `?homeId` (S19b), by name. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = contextSchema.safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const templates = await listTaskTemplates(homeId.data);
  if (templates.status === "not-found") return failure(404, "not-found");
  if (templates.status === "unavailable") return failure(500, "failed");
  return json(200, { templates: templates.value });
}

/**
 * Creates a template (S19b): the Personal space's owner, or in a Home its task managers. The id comes
 * from the client, so a retry answers the same template (200) instead of a second one.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readTaskMutation(request, createTemplateSchema, TASK_BODY_BYTES);
  if (!input.ok) return input.response;
  const template = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_task_template", {
    p_id: template.id,
    p_name: template.name,
    p_title: template.title,
    ...(template.description !== null ? { p_description: template.description } : {}),
    ...(template.priority !== null ? { p_priority: template.priority } : {}),
    p_label_ids: template.labelIds,
    p_subtasks: template.subtasks,
    ...(template.homeId ? { p_home_id: template.homeId } : {}),
  });
  if (error) return databaseFailure("tasks.template_create_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "tasks.template_create_failed",
    row?.outcome,
    { id: template.id, revision: row?.revision },
    { revision: row?.revision },
  );
}
