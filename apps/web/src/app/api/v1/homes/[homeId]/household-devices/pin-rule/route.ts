import { createSupabaseServerClient } from "@/auth/supabase-server";
import { pinRuleSchema } from "@/child-sign-in/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface PinRuleRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Sets when this Home asks for a PIN for chores confirmed on its household devices (S42 part 2):
 * for every chore (`{ requirePin }`), or always for one member or one chore (`{ kind, targetId,
 * requirePin }`); the stricter rule wins. The Owner, or an Administrator with
 * manageHomeSettings. The database decides again.
 */
export async function POST(request: Request, { params }: PinRuleRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, pinRuleSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const allowed = await requireHomeAction((await params).homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const home = allowed.context.home.id;
  const rule = input.data;
  const { data, error } =
    "kind" in rule
      ? await supabase.rpc("set_shared_device_pin_target", {
          p_home_id: home,
          p_kind: rule.kind,
          p_target_id: rule.targetId,
          p_require_pin: rule.requirePin,
        })
      : await supabase.rpc("set_shared_device_pin_rule", {
          p_home_id: home,
          p_require_pin: rule.requirePin,
        });
  if (error) return databaseFailure("shared_device_pin_rule.failed", error.code);
  if (data !== "saved" && data !== "unchanged") return outcomeFailure(data);
  return json(200, { outcome: data });
}
