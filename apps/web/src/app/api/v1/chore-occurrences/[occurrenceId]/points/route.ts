import { z } from "zod";

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
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { getChorePoints } from "@/points/data";
import { occurrencePointsSchema } from "@/points/schema";

interface OccurrencePointsRouteContext {
  readonly params: Promise<{ readonly occurrenceId: string }>;
}

const previewSchema = z.discriminatedUnion("preview", [
  z.strictObject({ preview: z.literal("reopen") }),
  z.strictObject({
    preview: z.literal("correct"),
    contributor: z.uuid().optional(),
    completedAt: z.iso.datetime({ offset: true }).optional(),
  }),
]);

/**
 * An occurrence's points (S23; members of its Home): base value and late policy, what completing now
 * earns, a pending award, the awarded points and their ledger lines (never balances). With
 * `preview=reopen` or `preview=correct` (and the correction's `contributor`, `completedAt`): the
 * point change reopening or correcting it would make (chore managers), or `{ change: null }`.
 */
export async function GET(
  request: Request,
  { params }: OccurrencePointsRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const search = new URL(request.url).searchParams;
  if (!search.has("preview")) {
    const points = await getChorePoints(id);
    if (points.status === "not-found") return failure(404, "not-found");
    if (points.status === "unavailable") return failure(500, "failed");
    return json(200, points.value);
  }
  const preview = previewSchema.safeParse(Object.fromEntries(search));
  if (!preview.success) return failure(400, "invalid");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_chore_points_change", {
    p_occurrence_id: id,
    p_action: preview.data.preview,
    ...(preview.data.preview === "correct" && preview.data.contributor
      ? { p_contributor: preview.data.contributor }
      : {}),
    ...(preview.data.preview === "correct" && preview.data.completedAt
      ? { p_completed_at: preview.data.completedAt }
      : {}),
  });
  if (error) return databaseFailure("points.chore_preview_failed", error);
  return json(200, { change: nullable(data) });
}

/**
 * Corrects one occurrence's points (S23; chore managers): open and pending ones directly; a completed
 * one also needs manageHomePoints and a reason, and its award is reconciled. `dryRun` answers the
 * impact first.
 */
export async function PUT(
  request: Request,
  { params }: OccurrencePointsRouteContext,
): Promise<Response> {
  const input = await readChoreMutation(request, occurrencePointsSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const id = pathId((await params).occurrenceId);
  if (!id) return failure(404, "not-found");
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_chore_occurrence_points", {
    p_occurrence_id: id,
    p_expected_revision: change.expectedRevision,
    p_points: change.setting.points,
    p_late_policy: change.setting.latePolicy,
    ...(change.setting.latePoints !== null ? { p_late_points: change.setting.latePoints } : {}),
    ...(change.reason !== null ? { p_reason: change.reason } : {}),
    p_dry_run: change.dryRun,
  });
  if (error) return databaseFailure("points.chore_set_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "points.chore_set_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row ? nullable(row.impact) : null, revision },
    { revision },
  );
}
