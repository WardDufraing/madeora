import { createSupabaseServerClient } from "@/auth/supabase-server";
import { childPresentationSchema } from "@/children/schema";
import { requireChildAction } from "@/children/server";
import { databaseFailure, json, outcomeFailure, readMemberMutation } from "@/members/manage-server";

const MAX_BODY_BYTES = 512;

interface PresentationRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
}

/**
 * A guardian sets the child's name and identifying colour in this Home, or resets the colour to a
 * suggested default (S41; spec "Confirmed child-controlled accent colors with guardian reset").
 * `public.set_child_presentation` checks the guardian role again under the Home lock.
 */
export async function PUT(
  request: Request,
  { params }: PresentationRouteContext,
): Promise<Response> {
  const input = await readMemberMutation(request, childPresentationSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, membershipId } = await params;

  const allowed = await requireChildAction(homeId, membershipId, "child.presentation.change");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_child_presentation", {
    p_home_id: allowed.context.home.id,
    p_child_membership_id: allowed.child.membershipId,
    p_display_name: input.data.displayName ?? "",
    p_accent_color: input.data.accentColor,
  });
  if (error) return databaseFailure("children.presentation_failed", error.code);
  return data === "saved" ? json(200, {}) : outcomeFailure(data);
}
