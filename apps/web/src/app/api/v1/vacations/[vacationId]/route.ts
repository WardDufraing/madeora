import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  pathId,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { getHomeVacation } from "@/vacations/data";
import { vacationAnswer } from "@/vacations/route-helpers";
import { vacationChangeSchema } from "@/vacations/schema";

interface VacationRouteContext {
  readonly params: Promise<{ readonly vacationId: string }>;
}

/** One vacation with what the caller may see and do (S22); members of its Home only. */
export async function GET(_request: Request, { params }: VacationRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).vacationId);
  if (!id) return failure(404, "not-found");
  const vacation = await getHomeVacation(id);
  if (vacation.status === "not-found") return failure(404, "not-found");
  if (vacation.status === "unavailable") return failure(500, "failed");
  return json(200, vacation.value);
}

/**
 * Changes a vacation (S22): rename (chore managers and the creator), reminder, shorten (end early),
 * cancel (chore managers, or the creator while nobody else is in it), and the Home-wide chore pause
 * (`pause` confirms the dates everyone is away, `unpause` removes it). `dryRun` answers the preview;
 * every change carries the revision the person saw.
 */
export async function PATCH(request: Request, { params }: VacationRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, vacationChangeSchema);
  if (!input.ok) return input.response;
  const id = pathId((await params).vacationId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_home_vacation", {
    p_vacation_id: id,
    p_expected_revision: change.expectedRevision,
    p_action: change.action,
    p_dry_run: change.dryRun,
    ...(change.action === "rename" && change.name !== null ? { p_name: change.name } : {}),
    ...(change.action === "reminder" && change.reminderDays !== null
      ? { p_reminder_days: change.reminderDays }
      : {}),
    ...(change.action === "shorten" ? { p_ends_on: change.endsOn } : {}),
  });
  if (error) return databaseFailure("vacations.update_failed", error);
  return vacationAnswer("vacations.update_failed", data[0]);
}
