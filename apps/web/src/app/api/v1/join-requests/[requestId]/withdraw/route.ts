import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMutation,
} from "@/invitations/route-helpers";

const MAX_BODY_BYTES = 256;
const emptyBody = z.strictObject({});

interface WithdrawRouteContext {
  readonly params: Promise<{ readonly requestId: string }>;
}

/** Withdraws the signed-in person's own pending join request (S10). */
export async function POST(request: Request, { params }: WithdrawRouteContext): Promise<Response> {
  const input = await readMutation(request, emptyBody, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { requestId } = await params;
  if (!z.uuid().safeParse(requestId).success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("withdraw_join_request", { p_request_id: requestId });
  if (error) return databaseFailure("join_requests.withdraw_failed", error.code);
  return data === "withdrawn" ? json(200, {}) : outcomeFailure(data);
}
