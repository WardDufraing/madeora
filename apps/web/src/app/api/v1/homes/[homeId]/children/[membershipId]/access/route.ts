import { isChildCapability } from "@madeora/domain/permissions";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { childAccessSchema } from "@/children/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 2048;

interface AccessRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * Changes a child's preset and overrides in this Home (S41; spec "Confirmed age-appropriate child
 * permission presets"). The primary guardian may change anything; the secondary guardian only
 * switches capabilities off. A change that adds any capability needs `confirmExpansion`, sent after
 * the guardian saw the before/after preview. `expectedUpdatedAt` refuses edits from an outdated
 * view (two guardians at once). `public.set_child_access` decides again under the Home lock.
 */
export async function PUT(request: Request, { params }: AccessRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, childAccessSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireChildAction(homeId, membershipId, "child.access.restrict");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_child_access", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
    p_preset: input.data.preset,
    p_overrides: input.data.overrides,
    p_confirm_expansion: input.data.confirmExpansion,
    p_expected_updated_at: input.data.expectedUpdatedAt,
  });
  if (error) return databaseFailure("children.access_failed", error.code);
  const row = data[0];
  if (row && (row.outcome === "saved" || row.outcome === "unchanged")) {
    return json(200, {
      outcome: row.outcome,
      before: row.before_capabilities.filter(isChildCapability),
      after: row.after_capabilities.filter(isChildCapability),
    });
  }
  return outcomeFailure(row?.outcome ?? "failed");
}
