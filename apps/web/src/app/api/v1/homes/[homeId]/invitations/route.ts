import { sendHomeInvitationEmail } from "@/email/send";
import type { CreatedInvitationResponse } from "@/invitations/api";
import { joinUrl } from "@/invitations/links";
import {
  databaseFailure,
  failure,
  json,
  logFailure,
  outcomeFailure,
  readMutation,
  requireHomeAction,
} from "@/invitations/route-helpers";
import { createInvitationSchema, formatJoinCode } from "@/invitations/schema";
import { deliveryStatuses, isOneOf, type DeliveryStatus } from "@/invitations/types";
import { createSupabaseServerClient } from "@/auth/supabase-server";

const MAX_BODY_BYTES = 2048;

interface InvitationsRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * Creates an email invitation, an invitation link or a join code (S10).
 *
 * The permission engine decides first (Administrator invitations are Owner-only); the database
 * function decides again with the person's own session, enforces the 25-invitation limit under a
 * lock, and returns the invitation an earlier attempt with the same request id created. For an
 * email invitation the email is sent here and its outcome recorded. The answer is the same for
 * any address: nothing here looks up whether it has an account.
 */
export async function POST(
  request: Request,
  { params }: InvitationsRouteContext,
): Promise<Response> {
  const input = await readMutation(request, createInvitationSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const body = input.data;
  const role = body.kind === "join_code" ? "member" : body.role;

  const { homeId } = await params;
  const allowed = await requireHomeAction(
    homeId,
    role === "administrator" ? "home.invitations.manageAdministrators" : "home.invitations.manage",
  );
  if (!allowed.ok) return allowed.response;
  const { home } = allowed.context;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_home_invitation", {
    p_home_id: home.id,
    p_kind: body.kind,
    p_role: role,
    p_request_id: body.requestId,
    ...(body.kind === "email"
      ? { p_recipient_email: body.email, p_email_locale: body.language, p_max_admissions: 1 }
      : {}),
    ...(body.kind === "link"
      ? { p_expires_in: body.expiresIn, p_max_admissions: body.maxUses }
      : {}),
    ...(body.kind === "join_code" ? { p_expires_in: body.expiresIn } : {}),
  });
  if (error) return databaseFailure("invitations.create_failed", error.code);
  const row = data[0];
  if (!row) return failure(500, "failed");
  if (row.outcome !== "created" && row.outcome !== "existing") return outcomeFailure(row.outcome);

  let delivery: DeliveryStatus | null = null;
  if (body.kind === "email") {
    delivery = isOneOf(deliveryStatuses, row.delivery_status) ? row.delivery_status : "pending";
    // A retried request whose email already went out is not sent twice; one that failed is.
    if (row.outcome === "created" || delivery !== "sent") {
      delivery = await sendHomeInvitationEmail(
        {
          locale: body.language,
          homeName: home.name,
          role,
          recipientEmail: body.email,
          url: joinUrl(row.token),
          expiresAt: new Date(row.expires_at),
          timeZone: home.timeZone,
        },
        // The same key for every attempt at this first email, so the provider sends it once.
        `invitation-${row.invitation_id}-first`,
      );
      const recorded = await supabase.rpc("record_home_invitation_delivery", {
        p_home_id: home.id,
        p_invitation_id: row.invitation_id,
        p_status: delivery,
      });
      if (recorded.error) logFailure("invitations.delivery_record_failed", recorded.error.code);
    }
  }

  const response: CreatedInvitationResponse = {
    invitation: {
      id: row.invitation_id,
      kind: body.kind,
      expiresAt: row.expires_at,
      url: body.kind === "email" ? null : joinUrl(row.token),
      code: body.kind === "join_code" ? formatJoinCode(row.token) : null,
      delivery,
    },
  };
  return json(row.outcome === "created" ? 201 : 200, response);
}
