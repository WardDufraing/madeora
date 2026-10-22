import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listChoreTemplates } from "@/chores/data";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { createTemplateSchema } from "@/chores/schema";
import { chorePointsArgs } from "@/points/chore-points";

/**
 * The Home's chore templates (S20), retired ones too with `retired=true`. Chore managers only:
 * anyone else in the Home gets an empty list, so titles stay hidden.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const retired = z
    .enum(["true", "false"])
    .optional()
    .safeParse(params.get("retired") ?? undefined);
  if (!homeId.success || !retired.success) return failure(400, "invalid");
  const templates = await listChoreTemplates(homeId.data, retired.data === "true");
  if (templates.status === "not-found") return failure(404, "not-found");
  if (templates.status === "unavailable") return failure(500, "failed");
  return json(200, { templates: templates.value });
}

/** Creates a template (S20, chore managers); the client's id makes a retry return the same one. */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, createTemplateSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const template = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_chore_template", {
    p_id: template.id,
    p_home_id: template.homeId,
    p_title: template.title,
    ...(template.instructions === null ? {} : { p_instructions: template.instructions }),
    ...(template.categoryId === null ? {} : { p_category_id: template.categoryId }),
    ...(template.minutes === null ? {} : { p_minutes: template.minutes }),
    p_steps: template.steps,
    ...chorePointsArgs(template.points),
  });
  if (error) return databaseFailure("chores.template_create_failed", error);
  const row = data[0];
  return outcomeAnswer("chores.template_create_failed", row?.outcome, {
    outcome: row?.outcome,
    revision: row ? nullable(row.revision) : null,
  });
}
