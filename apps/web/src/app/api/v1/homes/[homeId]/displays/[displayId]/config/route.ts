import type { Json } from "@madeora/database";
import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { checkDisplayLayout } from "@/displays/layout";
import { saveDisplayConfigSchema } from "@/displays/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 12 * 1024;

interface ConfigRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly displayId: string }>;
}

/**
 * Saves one display's layout and presentation (S44), only when nobody changed them since the
 * revision the manager edited (`409 conflict` with the current revision otherwise). `layout: null`
 * restores the default layout. Same managers as pairing.
 */
export async function POST(request: Request, { params }: ConfigRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, saveDisplayConfigSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, displayId } = await params;
  if (!z.uuid().safeParse(displayId).success) return failure(404, "not-found");
  const layout = input.data.layout === null ? null : checkDisplayLayout(input.data.layout);
  if (input.data.layout !== null && layout === null) return failure(400, "invalid");
  const allowed = await requireHomeAction(homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { preferences } = input.data;
  const { data, error } = await supabase.rpc("save_household_display_config", {
    p_home_id: allowed.context.home.id,
    p_display_id: displayId,
    p_expected_revision: input.data.expectedRevision,
    // The checked layout, re-serialised: only what the schema understood is stored.
    p_layout: layout === null ? null : (JSON.parse(JSON.stringify(layout)) as Json),
    p_orientation: preferences.orientation,
    p_theme: preferences.theme,
    p_density: preferences.density,
    p_clock_format: preferences.clockFormat,
  });
  if (error) return databaseFailure("household_displays.config_failed", error.code);
  const row = data[0];
  if (!row) return failure(503, "failed");
  if (row.outcome === "saved" || row.outcome === "unchanged") {
    return json(200, { revision: row.revision });
  }
  if (row.outcome === "conflict") return json(409, { error: "conflict", revision: row.revision });
  return outcomeFailure(row.outcome);
}
