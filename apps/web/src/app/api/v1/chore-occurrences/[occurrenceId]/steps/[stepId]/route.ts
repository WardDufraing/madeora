import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { StepResponse } from "@/chores/api";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readChoreMutation,
} from "@/chores/route-helpers";
import { stepCheckSchema } from "@/chores/schema";

interface StepRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string; readonly stepId: string }>;
}

/**
 * Ticks or unticks one checklist step of an open occurrence (S20, any current member). Set to a
 * state, so a retry or two people at once change nothing twice. Answers the occurrence's progress.
 */
export async function PUT(request: Request, { params }: StepRouteContext): Promise<Response> {
  const input = await readChoreMutation(request, stepCheckSchema);
  if (!input.ok) return input.response;
  const { occurrenceId, stepId } = await params;
  const step = pathId(stepId);
  if (!pathId(occurrenceId) || !step) return failure(404, "not-found");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_chore_step", {
    p_step_id: step,
    p_checked: input.data.checked,
  });
  if (error) return databaseFailure("chores.step_failed", error);
  const row = data[0];
  const body: StepResponse | object = row
    ? { checked: row.checked, done: row.done, total: row.total }
    : {};
  return outcomeAnswer("chores.step_failed", row?.outcome, body);
}
