import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { isOneOf } from "@/invitations/types";
import type { TransferActionResponse } from "@/members/manage-api";
import { emptyBodySchema, transferActions } from "@/members/manage-schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface TransferActionRouteContext {
  readonly params: Promise<{
    readonly homeId: string;
    readonly transferId: string;
    readonly action: string;
  }>;
}

/**
 * Answers or withdraws an ownership transfer (S12; spec "Confirmed Home ownership transfer",
 * "Confirmed exactly one Home Owner").
 *
 * - accept / decline: only the nominated member. Acceptance re-checks everything under the Home
 *   lock and swaps the two roles in one transaction: the recipient becomes the Owner and the former
 *   Owner a Member, with exactly one Owner at every moment.
 * - cancel: only the Owner who started it, while it is pending.
 */
export async function POST(
  request: Request,
  { params }: TransferActionRouteContext,
): Promise<Response> {
  const { homeId, transferId, action } = await params;
  if (!isOneOf(transferActions, action)) return failure(404, "not-found");
  const input = await readMemberMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  if (!z.uuid().safeParse(transferId).success) return failure(404, "not-found");

  // Any current member may be the recipient; the database checks that it is this caller.
  const allowed = await requireHomeAction(
    homeId,
    action === "cancel" ? "home.ownership.transfer" : "home.view",
  );
  if (!allowed.ok) return allowed.response;
  const { home } = allowed.context;
  const supabase = await createSupabaseServerClient();

  if (action === "cancel") {
    const { data, error } = await supabase.rpc("cancel_ownership_transfer", {
      p_home_id: home.id,
      p_transfer_id: transferId,
    });
    if (error) return databaseFailure("members.transfer_cancel_failed", error.code);
    if (data !== "cancelled") return outcomeFailure(data);
    const body: TransferActionResponse = { outcome: "cancelled" };
    return json(200, body);
  }

  const { data, error } = await supabase.rpc("respond_to_ownership_transfer", {
    p_home_id: home.id,
    p_transfer_id: transferId,
    p_decision: action,
  });
  if (error) return databaseFailure("members.transfer_response_failed", error.code);
  if (data !== "accepted" && data !== "declined") return outcomeFailure(data);
  const body: TransferActionResponse = { outcome: data };
  return json(200, body);
}
