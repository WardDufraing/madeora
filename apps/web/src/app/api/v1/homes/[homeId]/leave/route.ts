import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getHomeContext } from "@/homes/server";
import { emptyBodySchema } from "@/members/manage-schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 64;

interface LeaveRouteContext {
  readonly params: Promise<{ readonly homeId: string }>;
}

/**
 * The caller leaves the Home (S12; spec "Confirmed voluntary Home departure"). Members and
 * Administrators leave without anyone's approval. The Owner cannot while they are the Owner: they
 * answer 409 owner-must-transfer and follow the transfer-or-close flow instead.
 */
export async function POST(request: Request, { params }: LeaveRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, emptyBodySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId } = await params;

  const found = await getHomeContext(homeId);
  if (found.status === "ok" && found.context.membership.role === "owner") {
    return failure(409, "owner-must-transfer");
  }
  const allowed = await requireHomeAction(homeId, "home.leave");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("leave_home", { p_home_id: allowed.context.home.id });
  if (error) return databaseFailure("members.leave_failed", error.code);
  return data === "left" ? json(200, {}) : outcomeFailure(data);
}
