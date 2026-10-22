import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, pathId, readChoreMutation } from "@/chores/route-helpers";
import { vacationAnswer } from "@/vacations/route-helpers";
import { participationChangeSchema } from "@/vacations/schema";

interface ParticipantRouteContext {
  readonly params: Promise<{ readonly participantId: string }>;
}

/**
 * Changes one participation (S22): its invitee accepts or declines (an invitation expires at its
 * start, `409 expired`); a participant withdraws or changes their own dates; a chore manager removes
 * a participant or changes the dates of one a manager added; the creator or a chore manager withdraws
 * an invitation, and proposes new dates to an invited participant (who accepts or declines them).
 * `dryRun` answers the preview, e.g. the personal impact of accepting.
 */
export async function PATCH(
  request: Request,
  { params }: ParticipantRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, participationChangeSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).participantId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_vacation_participation", {
    p_participant_id: id,
    p_expected_revision: change.expectedRevision,
    p_action: change.action,
    p_dry_run: change.dryRun,
    ...(change.action === "change_dates" || change.action === "propose_dates"
      ? { p_starts_on: change.startsOn, p_ends_on: change.endsOn }
      : {}),
  });
  if (error) return databaseFailure("vacations.participation_failed", error);
  return vacationAnswer("vacations.participation_failed", data[0]);
}
