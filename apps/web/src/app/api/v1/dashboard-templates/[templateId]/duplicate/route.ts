import { createSupabaseServerClient } from "@/auth/supabase-server";
import { templateCopy } from "@/dashboard/layout";
import {
  databaseFailure,
  failure,
  json,
  layoutJson,
  newWidgetId,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { duplicateTemplateSchema, templateIdSchema } from "@/dashboard/schema";
import { listTemplates } from "@/dashboard/server";

interface DuplicateRouteContext {
  readonly params: Promise<{ readonly templateId: string }>;
}

/**
 * Copies a template the person may see (their own, or one shared into a Home they belong to) into a
 * new private template of their own (UX2c; redesign decision 31: duplicate presets). The copy has
 * the same kind, new widget ids and, like any personal template, no Home-bound widgets; it is not
 * shared anywhere until its owner shares it. The interface picks a free name.
 *
 * `POST { name }` → `201 { id, dropped }`; `404` for a template the person may not see; `409
 * limit-reached` at the template limit.
 */
export async function POST(request: Request, { params }: DuplicateRouteContext): Promise<Response> {
  const input = await readDashboardMutation(request, duplicateTemplateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = templateIdSchema.safeParse((await params).templateId);
  if (!id.success) return failure(404, "not-found");

  const visible = await listTemplates(null);
  if (visible.status === "unavailable") return failure(500, "unavailable");
  const source =
    visible.status === "ok" ? visible.templates.find((entry) => entry.id === id.data) : undefined;
  if (!source) return failure(404, "not-found");
  const copy = templateCopy(source.layout, newWidgetId);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_dashboard_template", {
    p_name: input.data.name,
    p_kind: source.kind,
    p_layout: layoutJson(copy.layout),
  });
  if (error) return databaseFailure("dashboard.template_duplicate_failed", error);
  const row = data[0];
  if (row?.outcome === "limit_reached") return failure(409, "limit-reached");
  if (row?.outcome !== "created") return failure(500, "failed");
  return json(201, { id: row.template_id, dropped: copy.dropped });
}
