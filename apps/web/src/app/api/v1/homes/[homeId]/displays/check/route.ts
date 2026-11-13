import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pairingCodeHash } from "@/displays/pairing-secret";
import { checkCodeSchema } from "@/displays/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 128;

interface CheckRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Looks up a tablet's pairing code so a Home manager can review the device before approving it
 * (S43): the Owner, or an Administrator with manageHomeSettings. Only the code's SHA-256 reaches
 * the database; wrong codes count against the manager's own limit.
 */
export async function POST(request: Request, { params }: CheckRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, checkCodeSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const allowed = await requireHomeAction((await params).homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("check_display_pairing_code", {
    p_home_id: allowed.context.home.id,
    p_code_hash: pairingCodeHash(input.data.code),
  });
  if (error) return databaseFailure("household_displays.check_failed", error.code);
  const row = data[0];
  if (row?.outcome !== "found" || !row.request_id || !row.requested_at || !row.expires_at) {
    return outcomeFailure(row?.outcome ?? "");
  }
  return json(200, {
    request: {
      id: row.request_id,
      deviceKind: row.device_kind,
      browser: row.browser,
      platform: row.platform,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
    },
  });
}
