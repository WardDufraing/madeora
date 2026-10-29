import { createSupabaseServerClient } from "@/auth/supabase-server";
import { readGoals } from "@/goals/data";
import {
  databaseFailure,
  outcomeAnswer,
  readAnswer,
  readGoalMutation,
  readGoalQuery,
} from "@/goals/route-helpers";
import { createGoalSchema, listQuerySchema } from "@/goals/schema";
import { getEffectiveTimeZone } from "@/preferences/server";

/** The goals of a context in one view (active, completed or archived), optionally searched by title. */
export async function GET(request: Request): Promise<Response> {
  const query = await readGoalQuery(request, listQuerySchema);
  if (!query.ok) return query.response;
  const { homeId, view, q } = query.data;
  return readAnswer(await readGoals(homeId ?? null, view, q?.trim() || null), "list");
}

/**
 * Creates a goal (a personal goal; a Home goal: goal managers). A measurable goal needs its target
 * and unit and starts with `initial` (default 0) as its first ledger entry. A personal goal without a
 * timezone takes the person's effective one. `renewedFrom` names the completed goal it continues.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readGoalMutation(request, createGoalSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const timeZone =
    body.homeId === null ? (body.timeZone ?? (await getEffectiveTimeZone()).timeZone) : null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_goal", {
    p_id: body.id,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
    p_kind: body.kind,
    p_title: body.title,
    ...(body.description === null ? {} : { p_description: body.description }),
    ...(body.measure === null
      ? {}
      : {
          p_target: body.measure.target,
          p_unit: body.measure.unit,
          p_unit_kind: body.measure.unitKind,
        }),
    ...(body.initial === null ? {} : { p_initial: body.initial }),
    ...(body.deadline === null ? {} : { p_deadline: body.deadline }),
    ...(timeZone === null ? {} : { p_time_zone: timeZone }),
    ...(body.renewedFrom === null ? {} : { p_renewed_from: body.renewedFrom }),
  });
  if (error) return databaseFailure("goals.create_failed", error);
  const row = data[0];
  return outcomeAnswer("goals.create_failed", row?.outcome, {
    id: body.id,
    revision: row?.revision ?? null,
  });
}
