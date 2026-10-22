import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listChores } from "@/chores/data";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { assignmentArg, ruleArgs, stepsArg } from "@/chores/rpc-args";
import { createChoreSchema } from "@/chores/schema";
import { chorePointsArgs } from "@/points/chore-points";

/** The Home's chores for managing them (S20): active ones, or ended ones with `ended=true`. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const params = new URL(request.url).searchParams;
  const homeId = z.uuid().safeParse(params.get("homeId"));
  const ended = z
    .enum(["true", "false"])
    .optional()
    .safeParse(params.get("ended") ?? undefined);
  if (!homeId.success || !ended.success) return failure(400, "invalid");
  const chores = await listChores(homeId.data, ended.data === "true");
  if (chores.status === "not-found") return failure(404, "not-found");
  if (chores.status === "unavailable") return failure(500, "failed");
  return json(200, { chores: chores.value });
}

/**
 * Creates a chore (S20, chore managers): one-off with a due date, or recurring with a rule (never
 * creating a date before today). The id comes from the client, so a retry returns the same chore.
 * Answers `201 { outcome, occurrenceId }` with the first occurrence to open.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, createChoreSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const chore = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_chore", {
    p_id: chore.id,
    p_home_id: chore.homeId,
    p_title: chore.title,
    p_assignment: assignmentArg(chore.assignment),
    p_steps: stepsArg(chore.steps),
    ...(chore.instructions !== null ? { p_instructions: chore.instructions } : {}),
    ...(chore.categoryId !== null ? { p_category_id: chore.categoryId } : {}),
    ...(chore.minutes !== null ? { p_minutes: chore.minutes } : {}),
    ...(chore.dueDate !== null ? { p_due_date: chore.dueDate } : {}),
    ...(chore.recurrence !== null ? ruleArgs(chore.recurrence) : {}),
    p_requires_approval: chore.requiresApproval,
    ...chorePointsArgs(chore.points),
  });
  if (error) return databaseFailure("chores.create_failed", error);
  const row = data[0];
  return outcomeAnswer("chores.create_failed", row?.outcome, {
    outcome: row?.outcome,
    occurrenceId: row ? nullable(row.occurrence_id) : null,
  });
}
