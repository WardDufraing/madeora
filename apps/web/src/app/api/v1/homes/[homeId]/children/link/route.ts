import { createSupabaseServerClient } from "@/auth/supabase-server";
import { redeemLinkSchema } from "@/children/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface LinkRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Links an existing child to this Home with a code their primary guardian in another Home issued
 * (S41). The caller becomes the child's primary guardian here. `public.redeem_child_link_code`
 * checks the code, the issuer's authority and both Homes under their locks, and rate-limits wrong
 * codes. Never logs the code.
 */
export async function POST(request: Request, { params }: LinkRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, redeemLinkSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;
  const allowed = await requireHomeAction(homeId, "home.members.view");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("redeem_child_link_code", {
    p_home_id: allowed.context.home.id,
    p_code: input.data.code,
    p_accent_color: input.data.accentColor,
  });
  if (error) return databaseFailure("children.link_failed", error.code);
  const row = data[0];
  if (row?.outcome === "linked" && row.membership_id) {
    return json(201, { child: { membershipId: row.membership_id } });
  }
  return outcomeFailure(row?.outcome ?? "failed");
}
