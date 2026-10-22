import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readChoreMutation,
  requireReader,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { listHomeVacations } from "@/vacations/data";
import { vacationAnswer } from "@/vacations/route-helpers";
import { vacationCreateSchema } from "@/vacations/schema";

/**
 * A Home's vacations (S22; every current member): active and upcoming ones, recent history, and the
 * caller's own pending invitations and date proposals. A Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const list = await listHomeVacations(homeId.data);
  if (list.status === "not-found") return failure(404, "not-found");
  if (list.status === "unavailable") return failure(500, "failed");
  return json(200, list.value);
}

/**
 * Records a vacation (S22): a chore manager for any members, added directly; any other member for
 * themselves, with others suggested as invitations. `dryRun` answers the preview (the rotation turns
 * that pass on, what is left for review). The id comes from the client, so a retry answers `exists`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, vacationCreateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const vacation = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_home_vacation", {
    p_id: vacation.id,
    p_home_id: vacation.homeId,
    p_people: vacation.people,
    p_dry_run: vacation.dryRun,
    // An empty name is no name (the generic "Home vacation").
    p_name: vacation.name ?? "",
    ...(vacation.reminderDays ? { p_reminder_days: vacation.reminderDays } : {}),
  });
  if (error) return databaseFailure("vacations.create_failed", error);
  return vacationAnswer("vacations.create_failed", data[0]);
}
