import type { ChildAction } from "@madeora/domain/permissions";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { childSignInActionSchema, type ChildSignInActionInput } from "@/child-sign-in/schema";
import { hashChildSecret } from "@/child-sign-in/secret-hash";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 512;

interface SignInRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

type Action = ChildSignInActionInput["action"];

/**
 * Which engine action a request needs (S42). The database applies the finer rule: either guardian
 * may turn a switch off, only the primary guardian may turn one on.
 */
const engineAction: { readonly [A in Action]: ChildAction } = {
  username: "child.signIn.manage",
  password: "child.signIn.manage",
  pin: "child.signIn.assist",
  clear: "child.signIn.assist",
  access: "child.signIn.assist",
  unlock: "child.signIn.assist",
  "end-sessions": "child.signIn.assist",
};

const successOutcomes = new Set(["saved", "unchanged", "cleared", "unlocked", "ended"]);

/**
 * A guardian manages a child's sign-in (S42; spec "Confirmed guardian-managed child sign-in" and
 * "Confirmed primary and secondary child guardian authority"). Passwords and PINs are hashed here,
 * before anything reaches the database, and are never logged or echoed back.
 */
export async function POST(request: Request, { params }: SignInRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, childSignInActionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;
  const action = input.data;
  const allowed = await requireChildAction(homeId, membershipId, engineAction[action.action]);
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const home = allowed.context.home.id;
  const child = allowed.child.membershipId;
  let result: { readonly data: string | null; readonly error: { readonly code: string } | null };
  switch (action.action) {
    case "username":
      result = await supabase.rpc("set_child_username", {
        p_home_id: home,
        p_child_membership_id: child,
        p_username: action.username,
      });
      break;
    case "password":
    case "pin":
      result = await supabase.rpc("set_child_credential", {
        p_home_id: home,
        p_child_membership_id: child,
        p_kind: action.action,
        p_hash: await hashChildSecret(action.action === "pin" ? action.pin : action.password),
      });
      break;
    case "clear":
      result = await supabase.rpc("clear_child_credential", {
        p_home_id: home,
        p_child_membership_id: child,
        p_kind: action.credential,
      });
      break;
    case "access":
      result = await supabase.rpc("set_child_sign_in_access", {
        p_home_id: home,
        p_child_membership_id: child,
        p_password_sign_in: action.passwordSignIn,
        p_pin_sign_in: action.pinSignIn,
      });
      break;
    case "unlock":
      result = await supabase.rpc("unlock_child_sign_in", {
        p_home_id: home,
        p_child_membership_id: child,
      });
      break;
    case "end-sessions": {
      const ended = await supabase.rpc("end_child_sign_ins", {
        p_home_id: home,
        p_child_membership_id: child,
      });
      result = { data: ended.data?.[0]?.outcome ?? null, error: ended.error };
      break;
    }
  }
  if (result.error) return databaseFailure("children.sign_in_change_failed", result.error.code);
  const outcome = result.data ?? "failed";
  return successOutcomes.has(outcome) ? json(200, { outcome }) : outcomeFailure(outcome);
}
