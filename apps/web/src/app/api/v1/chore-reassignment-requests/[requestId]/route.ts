import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { reassignmentAnswerSchema } from "@/chores/schema";

interface RequestRouteContext {
  readonly params: Promise<{ readonly requestId: string }>;
}

/**
 * Answers a reassignment request (S21): the recipient accepts or declines, the requester cancels,
 * a chore manager confirms or refuses one that waits for confirmation. Accepting and confirming
 * re-check the occurrence; a request that no longer fits answers `409 invalidated`, one already
 * answered `409 not-open` with its status.
 */
export async function PATCH(request: Request, { params }: RequestRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, reassignmentAnswerSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).requestId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("answer_chore_reassignment", {
    p_request_id: id,
    p_action: input.data.action,
  });
  if (error) return databaseFailure("chores.reassignment_answer_failed", error);
  const row = data[0];
  const status = row ? nullable(row.status) : null;
  if (row?.outcome === "not_open") {
    return failure(409, "not-open", status === null ? {} : { status });
  }
  return outcomeAnswer("chores.reassignment_answer_failed", row?.outcome, {
    outcome: row?.outcome,
    status,
  });
}
