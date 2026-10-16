import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { renameTemplateSchema, templateIdSchema } from "@/dashboard/schema";
import { z } from "zod";

interface TemplateRouteContext {
  readonly params: Promise<{ readonly templateId: string }>;
}

const emptySchema = z.strictObject({});

/** Renames one of the person's own templates (S17). Anyone else's answers 404. */
export async function PATCH(request: Request, { params }: TemplateRouteContext): Promise<Response> {
  const input = await readDashboardMutation(request, renameTemplateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = templateIdSchema.safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rename_dashboard_template", {
    p_template_id: id.data,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("dashboard.template_rename_failed", error);
  return data === "ok" ? json(200, {}) : failure(404, "not-found");
}

/**
 * Moves one of the person's own templates to their trash (S17, S16): it and its shares can be
 * restored for 7 days. Anyone else's answers 404.
 */
export async function DELETE(
  request: Request,
  { params }: TemplateRouteContext,
): Promise<Response> {
  const input = await readDashboardMutation(request, emptySchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = templateIdSchema.safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_dashboard_template", {
    p_template_id: id.data,
  });
  if (error) return databaseFailure("dashboard.template_delete_failed", error);
  // The generated types call the result non-null; it is null when the template is not theirs.
  const entry: string | null = data;
  return entry ? json(200, { trashEntryId: entry }) : failure(404, "not-found");
}
