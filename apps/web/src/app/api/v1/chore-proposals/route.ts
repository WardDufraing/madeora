import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listChoreProposals } from "@/chores/data";
import {
  CHORE_BODY_BYTES,
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { stepsArg } from "@/chores/rpc-args";
import { proposalSchema } from "@/chores/schema";

/**
 * The chore proposals the caller may see in a Home (S21): their own, and for chore managers every
 * waiting one and those decided in the last 30 days. A Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const proposals = await listChoreProposals(homeId.data);
  if (proposals.status === "not-found") return failure(404, "not-found");
  if (proposals.status === "unavailable") return failure(500, "failed");
  return json(200, proposals.value);
}

/**
 * Proposes a one-off unassigned chore (S21, any current member; spec "member-proposed unassigned
 * chores"). Nothing is scheduled until a chore manager approves it. The id comes from the client,
 * so a retry answers `exists`. `409 duplicate`: the caller already proposes one with that title.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, proposalSchema, CHORE_BODY_BYTES);
  if (!input.ok) return input.response;
  const proposal = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("propose_chore", {
    p_id: proposal.id,
    p_home_id: proposal.homeId,
    p_title: proposal.title,
    p_due_date: proposal.dueDate,
    p_steps: stepsArg(proposal.steps),
    ...(proposal.instructions !== null ? { p_instructions: proposal.instructions } : {}),
    ...(proposal.categoryId !== null ? { p_category_id: proposal.categoryId } : {}),
    ...(proposal.minutes !== null ? { p_minutes: proposal.minutes } : {}),
  });
  if (error) return databaseFailure("chores.propose_failed", error);
  const row = data[0];
  const body = { outcome: row?.outcome, revision: row?.revision ?? null };
  if (row?.outcome === "proposed") return json(201, body);
  return outcomeAnswer("chores.propose_failed", row?.outcome, body);
}
