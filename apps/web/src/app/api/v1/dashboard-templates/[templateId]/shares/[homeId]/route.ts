import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { templateIdSchema } from "@/dashboard/schema";
import { homeIdSchema } from "@/homes/schema";

interface ShareRouteContext {
  readonly params: Promise<{ readonly templateId: string; readonly homeId: string }>;
}

const emptySchema = z.strictObject({});

async function ids(
  params: ShareRouteContext["params"],
): Promise<{ readonly templateId: string; readonly homeId: string } | null> {
  const raw = await params;
  const templateId = templateIdSchema.safeParse(raw.templateId);
  const homeId = homeIdSchema.safeParse(raw.homeId);
  return templateId.success && homeId.success
    ? { templateId: templateId.data, homeId: homeId.data }
    : null;
}

/**
 * Shares one of the person's own templates into a Home they belong to (S17; owner decision "split
 * by target"): any member may share a personal-dashboard template; a Home-dashboard template only
 * someone who may edit that Home's dashboard. The database decides; 403 when the kind is not theirs
 * to share there, 404 when the template or the Home is not theirs.
 */
export async function PUT(request: Request, { params }: ShareRouteContext): Promise<Response> {
  const input = await readDashboardMutation(request, emptySchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const target = await ids(params);
  if (!target) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("share_dashboard_template", {
    p_template_id: target.templateId,
    p_home_id: target.homeId,
  });
  if (error) return databaseFailure("dashboard.template_share_failed", error);
  if (data === "shared" || data === "unchanged") return json(200, { outcome: data });
  return data === "not_permitted" ? failure(403, "not-permitted") : failure(404, "not-found");
}

/**
 * Ends a template's share in a Home: its owner, or someone who may edit that Home's dashboard.
 */
export async function DELETE(request: Request, { params }: ShareRouteContext): Promise<Response> {
  const input = await readDashboardMutation(request, emptySchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const target = await ids(params);
  if (!target) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("unshare_dashboard_template", {
    p_template_id: target.templateId,
    p_home_id: target.homeId,
  });
  if (error) return databaseFailure("dashboard.template_unshare_failed", error);
  return data === "removed" ? json(200, {}) : failure(404, "not-found");
}
