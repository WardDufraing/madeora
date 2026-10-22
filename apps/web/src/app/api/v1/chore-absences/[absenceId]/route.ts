import { createSupabaseServerClient } from "@/auth/supabase-server";
import { databaseFailure, failure, pathId, readChoreMutation } from "@/chores/route-helpers";
import { vacationAnswer } from "@/vacations/route-helpers";
import { absenceChangeSchema } from "@/vacations/schema";

interface AbsenceRouteContext {
  readonly params: Promise<{ readonly absenceId: string }>;
}

/**
 * Changes an absence (S22; its member or a chore manager): new dates (ending early included; one
 * under way keeps its start) and reason, or removal. Decisions already taken stay.
 */
export async function PATCH(request: Request, { params }: AbsenceRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, absenceChangeSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).absenceId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  if (change.action === "remove") {
    const { data, error } = await supabase.rpc("delete_chore_absence", {
      p_id: id,
      p_expected_revision: change.expectedRevision,
    });
    if (error) return databaseFailure("vacations.absence_delete_failed", error);
    return vacationAnswer("vacations.absence_delete_failed", data[0]);
  }
  const { data, error } = await supabase.rpc("save_chore_absence", {
    p_id: id,
    p_home_id: change.homeId,
    p_member: change.memberId,
    p_starts_on: change.startsOn,
    p_ends_on: change.endsOn,
    p_expected_revision: change.expectedRevision,
    ...(change.reason ? { p_reason: change.reason } : {}),
  });
  if (error) return databaseFailure("vacations.absence_update_failed", error);
  return vacationAnswer("vacations.absence_update_failed", data[0]);
}
