import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { EmailSentResponse } from "@/invitations/api";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMutation,
  requireHomeAction,
} from "@/invitations/route-helpers";
import { isOneOf } from "@/invitations/types";

const MAX_BODY_BYTES = 256;
const actions = ["revoke", "resend", "renew"] as const;
const emptyBody = z.strictObject({});

interface InvitationActionRouteContext {
  readonly params: Promise<{
    readonly homeId: string;
    readonly invitationId: string;
    readonly action: string;
  }>;
}

/**
 * Revoke, resend or renew one invitation (S10; spec "Confirmed active invitation management",
 * "Confirmed email invitation resend and renewal").
 *
 * - revoke: the link or code stops working at once.
 * - resend: the same email, link and expiry again (rate-limited in the database).
 * - renew: a new link with a fresh 7 days; the old link is dead before this answers.
 *
 * Resend and renew queue the email in the database transaction (S14); a background job sends it.
 */
export async function POST(
  request: Request,
  { params }: InvitationActionRouteContext,
): Promise<Response> {
  const { homeId, invitationId, action } = await params;
  if (!isOneOf(actions, action)) return failure(404, "not-found");
  const input = await readMutation(request, emptyBody, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  if (!z.uuid().safeParse(invitationId).success) return failure(404, "not-found");

  const allowed = await requireHomeAction(homeId, "home.invitations.manage");
  if (!allowed.ok) return allowed.response;
  const { home } = allowed.context;
  const supabase = await createSupabaseServerClient();

  if (action === "revoke") {
    const { data, error } = await supabase.rpc("revoke_home_invitation", {
      p_home_id: home.id,
      p_invitation_id: invitationId,
    });
    if (error) return databaseFailure("invitations.revoke_failed", error.code);
    return data === "revoked" ? json(200, {}) : outcomeFailure(data);
  }

  const { data, error } = await supabase.rpc(
    action === "renew" ? "renew_home_invitation" : "resend_home_invitation",
    { p_home_id: home.id, p_invitation_id: invitationId },
  );
  if (error) return databaseFailure(`invitations.${action}_failed`, error.code);
  const row = data[0];
  if (!row) return failure(500, "failed");
  if (row.outcome !== "ok") return outcomeFailure(row.outcome);
  if (!row.expires_at) return failure(500, "failed");

  // The database queued the email with this change; a background job sends it (S14).
  const response: EmailSentResponse = { delivery: "pending", expiresAt: row.expires_at };
  return json(200, response);
}
