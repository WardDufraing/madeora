import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getVerifiedIdentity } from "@/auth/identity";
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
import { createTemplateSchema } from "@/dashboard/schema";
import { listTemplates, loadTarget } from "@/dashboard/server";
import { homeIdSchema } from "@/homes/schema";

/**
 * The templates the signed-in person may see (S17): their own, and those shared into a Home they
 * belong to, or with `homeId` only those shared into that Home (404 when they are not a member).
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const params = new URL(request.url).searchParams;
  for (const name of params.keys()) {
    if (name !== "homeId") return failure(400, "invalid", { fields: [name] });
  }
  const raw = params.get("homeId");
  const homeId = raw === null ? null : homeIdSchema.safeParse(raw);
  if (homeId && !homeId.success) return failure(400, "invalid", { fields: ["homeId"] });
  const result = await listTemplates(homeId ? homeId.data : null);
  if (result.status === "not-found") return failure(404, "not-found");
  if (result.status === "unavailable") return failure(500, "unavailable");
  return json(200, {
    templates: result.templates.map((template) => ({
      id: template.id,
      name: template.name,
      kind: template.kind,
      isMine: template.isMine,
      sharedHomeIds: template.sharedHomeIds,
      widgets: template.layout.widgets.map((widget) => widget.type),
    })),
  });
}

/**
 * Saves a dashboard's current arrangement as a new private template (S17). Its kind follows the
 * dashboard it came from. Widgets bound to a Home are left out of a personal template (a template
 * must not carry a Home the next person may not belong to); `dropped` says how many.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, createTemplateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const { name, from } = input.data;

  const current = await loadTarget(from);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  const copy = templateCopy(current.dashboard.layout, newWidgetId);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_dashboard_template", {
    p_name: name,
    p_kind: from.kind,
    p_layout: layoutJson(copy.layout),
  });
  if (error) return databaseFailure("dashboard.template_create_failed", error);
  const row = data[0];
  if (row?.outcome === "limit_reached") return failure(409, "limit-reached");
  if (row?.outcome !== "created") return failure(500, "failed");
  return json(201, { id: row.template_id, dropped: copy.dropped });
}
