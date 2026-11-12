import { createSupabaseServerClient } from "@/auth/supabase-server";
import { offerActionSchema } from "@/children/schema";
import {
  databaseFailure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface OfferRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly offerId: string }>;
}

/**
 * Answers a guardian offer (S41): the named adult accepts or declines; whoever made it, or the
 * child's primary guardian, withdraws it. Accepting re-checks under the Home lock that the offer
 * still stands (`public.answer_child_guardian_offer`, `public.cancel_child_guardian_offer`).
 */
export async function POST(request: Request, { params }: OfferRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, offerActionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, offerId } = await params;
  const allowed = await requireHomeAction(homeId, "home.members.view");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } =
    input.data.action === "cancel"
      ? await supabase.rpc("cancel_child_guardian_offer", { p_offer_id: offerId })
      : await supabase.rpc("answer_child_guardian_offer", {
          p_offer_id: offerId,
          p_accept: input.data.action === "accept",
        });
  if (error) return databaseFailure("children.offer_failed", error.code);
  return data === "accepted" || data === "declined" || data === "cancelled"
    ? json(200, { outcome: data })
    : outcomeFailure(data);
}
