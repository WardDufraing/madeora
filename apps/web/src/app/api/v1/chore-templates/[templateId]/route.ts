import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { updateTemplateSchema } from "@/chores/schema";
import { chorePointsArgs } from "@/points/chore-points";

interface TemplateRouteContext {
  readonly params: Promise<{ readonly templateId: string }>;
}

/**
 * Changes a template's fields, or retires or reinstates it (S20, chore managers). Chores made from
 * it never change.
 */
export async function PATCH(request: Request, { params }: TemplateRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, updateTemplateSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).templateId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_chore_template", {
    p_id: id,
    p_expected_revision: change.expectedRevision,
    p_title: change.title,
    ...(change.instructions === null ? {} : { p_instructions: change.instructions }),
    ...(change.categoryId === null ? {} : { p_category_id: change.categoryId }),
    ...(change.minutes === null ? {} : { p_minutes: change.minutes }),
    p_steps: change.steps,
    ...(change.retired === undefined ? {} : { p_retired: change.retired }),
    ...(change.points === undefined ? {} : chorePointsArgs(change.points)),
  });
  if (error) return databaseFailure("chores.template_update_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.template_update_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
