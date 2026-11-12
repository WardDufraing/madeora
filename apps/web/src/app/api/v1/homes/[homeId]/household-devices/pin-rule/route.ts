import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pinRuleSchema } from "@/child-sign-in/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 128;

interface PinRuleRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Sets whether this Home asks for a PIN for every chore confirmed on its household devices (S42
 * part 2): the Owner, or an Administrator with manageHomeSettings. The database decides again.
 */
export async function POST(request: Request, { params }: PinRuleRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, pinRuleSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const allowed = await requireHomeAction((await params).homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_shared_device_pin_rule", {
    p_home_id: allowed.context.home.id,
    p_require_pin: input.data.requirePin,
  });
  if (error) return databaseFailure("shared_device_pin_rule.failed", error.code);
  if (data !== "saved" && data !== "unchanged") return outcomeFailure(data);
  return json(200, { outcome: data });
}
