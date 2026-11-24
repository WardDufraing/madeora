import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeDisplaySettingsSchema } from "@/displays/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface SettingsRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Saves the Home's display settings (UX8a): how long its displays wait without a touch before the
 * ambient view. The Owner, or an Administrator granted manageHomeSettings; the database checks
 * again.
 */
export async function POST(request: Request, { params }: SettingsRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, homeDisplaySettingsSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  const allowed = await requireHomeAction(homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_home_display_settings", {
    p_home_id: allowed.context.home.id,
    p_ambient_after_seconds: input.data.ambientAfterSeconds,
  });
  if (error) return databaseFailure("home_display_settings.save_failed", error.code);
  return data === "saved" || data === "unchanged" ? json(200, {}) : outcomeFailure(data);
}
