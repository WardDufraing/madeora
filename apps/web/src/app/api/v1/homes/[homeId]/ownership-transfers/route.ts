import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { StartTransferResponse } from "@/members/manage-api";
import { startTransferSchema } from "@/members/manage-schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireMemberAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface TransfersRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * The Owner nominates an existing member of this Home as the next Owner (S12; spec "Confirmed Home
 * ownership transfer"). Nothing changes until that member accepts. One pending transfer per Home
 * (409 pending-exists); a repeated `requestId` returns the transfer it already started.
 */
export async function POST(request: Request, { params }: TransfersRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, startTransferSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;

  const allowed = await requireMemberAction(
    homeId,
    input.data.membershipId,
    "member.nominateOwner",
  );
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_ownership_transfer", {
    p_home_id: allowed.context.home.id,
    p_membership_id: allowed.target.membershipId,
    p_request_id: input.data.requestId,
  });
  if (error) return databaseFailure("members.transfer_start_failed", error.code);
  const row = data[0];
  if (!row) return failure(500, "failed");
  if (row.outcome !== "started") return outcomeFailure(row.outcome);
  const body: StartTransferResponse = { transfer: { id: row.transfer_id } };
  return json(201, body);
}
