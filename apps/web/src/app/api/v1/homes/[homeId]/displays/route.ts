import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pairingCodeHash } from "@/displays/pairing-secret";
import { approveDisplaySchema } from "@/displays/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 512;

interface DisplaysRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Approves a reviewed tablet as a Household Display of this Home under the chosen name (S43). The
 * database binds the request, the code, the Home and this manager in one locked step, so a second
 * approval of the same code (another manager, another Home, a replay) is refused. The display gets
 * its own account; nothing of this manager's session reaches the tablet.
 */
export async function POST(request: Request, { params }: DisplaysRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, approveDisplaySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const allowed = await requireHomeAction((await params).homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("approve_display_pairing", {
    p_home_id: allowed.context.home.id,
    p_request_id: input.data.requestId,
    p_code_hash: pairingCodeHash(input.data.code),
    p_name: input.data.name,
  });
  if (error) return databaseFailure("household_displays.approve_failed", error.code);
  const row = data[0];
  if (row?.outcome !== "approved" || !row.display_id) return outcomeFailure(row?.outcome ?? "");
  return json(201, { display: { id: row.display_id } });
}
