import { createSupabaseServerClient } from "@/auth/supabase-server";
import { createChildSchema } from "@/children/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 1024;

interface ChildrenRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Home → Members → Add child (S41; spec "Confirmed quick child creation"): a name, an eligible
 * primary guardian, an identifying colour and optionally an age band (a preset hint only). No
 * email, username, PIN or password. The database decides who may add a child and who may be
 * named guardian (`public.create_child`), under the Home lock; a retry with the same `requestId`
 * returns the same child.
 */
export async function POST(request: Request, { params }: ChildrenRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, createChildSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;

  const allowed = await requireHomeAction(homeId, "home.members.view");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_child", {
    p_home_id: allowed.context.home.id,
    p_name: input.data.name,
    p_primary_guardian_membership_id: input.data.primaryGuardianMembershipId,
    p_age_band: input.data.ageBand ?? "",
    p_accent_color: input.data.accentColor,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("children.create_failed", error.code);
  const row = data[0];
  if (row?.outcome === "created" && row.membership_id) {
    return json(201, { child: { membershipId: row.membership_id } });
  }
  return outcomeFailure(row?.outcome ?? "failed");
}
