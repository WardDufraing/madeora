import { getChoreVolunteerState } from "@/chores/data";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  pathId,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { volunteerRequestSchema } from "@/chores/schema";

interface OccurrenceRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

/**
 * The volunteer side of an occurrence for the caller (S21): for chore managers every request with
 * every invitation; for an invitee their own invitation only.
 */
export async function GET(
  _request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const state = await getChoreVolunteerState(id);
  if (state.status === "not-found") return failure(404, "not-found");
  if (state.status === "unavailable") return failure(500, "failed");
  return json(200, { volunteers: state.value });
}

/**
 * Asks selected members to volunteer for an occurrence in Needs assignment review (S21, chore
 * managers), at the revision the manager saw; `dryRun` answers the preview with the deadline (the
 * end of the due day in the Home's timezone). The id comes from the client, so a retry answers
 * `exists`.
 */
export async function POST(
  request: Request,
  { params }: OccurrenceRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, volunteerRequestSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_chore_volunteer_request", {
    p_id: input.data.id,
    p_occurrence_id: id,
    p_expected_revision: input.data.expectedRevision,
    p_member_ids: input.data.memberIds,
    p_dry_run: input.data.dryRun,
  });
  if (error) return databaseFailure("chores.volunteer_request_failed", error);
  const row = data[0];
  if (row?.outcome === "invalid_recipient") {
    return failure(400, "invalid", { fields: ["memberIds"] });
  }
  const body = { outcome: row?.outcome, deadline: row ? nullable(row.deadline) : null };
  if (row?.outcome === "sent") return json(201, body);
  return outcomeAnswer("chores.volunteer_request_failed", row?.outcome, body, {
    revision: row ? nullable(row.revision) : null,
  });
}
