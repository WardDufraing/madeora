import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { volunteerChangeSchema } from "@/chores/schema";

interface RequestRouteContext {
  readonly params: Promise<{ readonly requestId: string }>;
}

/**
 * Answers or changes a volunteer request (S21). An invitee accepts (the first valid acceptance
 * wins) or declines. A chore manager withdraws pending invitations, adds members not invited
 * before, or cancels the request. An invitation no longer open answers `409 not-open` with its
 * status; an acceptance after the deadline `409 expired`.
 */
export async function PATCH(request: Request, { params }: RequestRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, volunteerChangeSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).requestId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  if (change.action === "accept" || change.action === "decline") {
    const { data, error } = await supabase.rpc("answer_chore_volunteer_invitation", {
      p_request_id: id,
      p_action: change.action,
    });
    if (error) return databaseFailure("chores.volunteer_answer_failed", error);
    const row = data[0];
    if (row?.outcome === "not_open") {
      return failure(409, "not-open", { status: row.status });
    }
    return outcomeAnswer("chores.volunteer_answer_failed", row?.outcome, {
      outcome: row?.outcome,
    });
  }
  const { data, error } = await supabase.rpc("change_chore_volunteer_request", {
    p_request_id: id,
    p_action: change.action,
    ...("memberIds" in change ? { p_member_ids: change.memberIds } : {}),
  });
  if (error) return databaseFailure("chores.volunteer_change_failed", error);
  const row = data[0];
  if (row?.outcome === "not_open") {
    return failure(409, "not-open", { status: row.status });
  }
  if (row?.outcome === "invalid_recipient") {
    return failure(400, "invalid", { fields: ["memberIds"] });
  }
  if (row?.outcome === "added" || row?.outcome === "withdrawn" || row?.outcome === "cancelled") {
    return json(200, {
      outcome: row.outcome,
      closed: row.closed,
      skipped: nullable(row.skipped) ?? [],
    });
  }
  return outcomeAnswer("chores.volunteer_change_failed", row?.outcome, { outcome: row?.outcome });
}
