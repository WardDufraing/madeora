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
import { reassignmentRequestSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * Asks a current member to take over the caller's part of an open occurrence they are assigned to
 * (S21, spec "request-based chore reassignment"), with an optional note; a chore manager may name
 * the assignee (`fromMember`, `403 not-permitted` for anyone else). Nothing changes until the
 * recipient accepts. The id comes from the client, so a retry answers the same request (`exists`).
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, reassignmentRequestSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_chore_reassignment", {
    p_id: input.data.id,
    p_occurrence_id: id,
    p_to_member: input.data.toMember,
    ...(input.data.note !== null ? { p_note: input.data.note } : {}),
    ...(input.data.fromMember !== undefined ? { p_from_member: input.data.fromMember } : {}),
  });
  if (error) return databaseFailure("chores.reassignment_request_failed", error);
  const row = data[0];
  const body = { outcome: row?.outcome, status: row ? nullable(row.status) : null };
  if (row?.outcome === "requested") return json(201, body);
  return outcomeAnswer("chores.reassignment_request_failed", row?.outcome, body);
}
