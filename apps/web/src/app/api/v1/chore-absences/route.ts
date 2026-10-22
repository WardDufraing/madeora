import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { listChoreAbsences } from "@/vacations/data";
import { vacationAnswer } from "@/vacations/route-helpers";
import { absenceCreateSchema } from "@/vacations/schema";

/**
 * Temporary chore absences in a Home (S22): the caller's own, and everyone's for chore managers,
 * with their private reasons and how many affected occurrences wait for a decision.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const list = await listChoreAbsences(homeId.data);
  if (list.status === "not-found") return failure(404, "not-found");
  if (list.status === "unavailable") return failure(500, "failed");
  return json(200, list.value);
}

/**
 * Registers an absence (S22): a member their own, a chore manager anyone's. A planning signal only:
 * nothing changes on its own. The id comes from the client, so a retry answers `exists`.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, absenceCreateSchema);
  if (!input.ok) return input.response;
  const absence = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_chore_absence", {
    p_id: absence.id,
    p_home_id: absence.homeId,
    p_member: absence.memberId,
    p_starts_on: absence.startsOn,
    p_ends_on: absence.endsOn,
    ...(absence.reason ? { p_reason: absence.reason } : {}),
  });
  if (error) return databaseFailure("vacations.absence_create_failed", error);
  return vacationAnswer("vacations.absence_create_failed", data[0]);
}
