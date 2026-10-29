import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readHabitMutation,
} from "@/habits/route-helpers";
import { changeTrackingSchema } from "@/habits/schema";

interface HabitRouteContext {
  readonly params: Promise<{ readonly habitId: string }>;
}

/**
 * Previews (`preview: true`) or applies a tracking change: complete once or a numeric daily target.
 * A mode or unit change applies from tomorrow; a target-only change may apply today, on the next
 * scheduled day or on a chosen date. Refusals that need the person's answer (`confirm-unit`,
 * `confirm-status`, `stale`) come with the impact; a change that changes nothing answers
 * `409 unchanged`.
 */
export async function POST(request: Request, { params }: HabitRouteContext): Promise<Response> {
  const input = await readHabitMutation(request, changeTrackingSchema);
  if (!input.ok) return input.response;
  const habitId = pathId((await params).habitId);
  if (!habitId) return failure(404, "not-found");
  const body = input.data;
  const tracking = body.tracking;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("change_habit_tracking", {
    p_id: habitId,
    p_expected_revision: body.revision,
    p_mode: tracking === null ? "once" : "numeric",
    ...(tracking === null
      ? {}
      : {
          p_target: tracking.target,
          p_unit: tracking.unit,
          p_unit_kind: tracking.unitKind,
          ...(tracking.quickAdds.length === 0 ? {} : { p_quick_adds: tracking.quickAdds }),
        }),
    p_when: body.when,
    ...(body.effectiveOn === null ? {} : { p_effective_on: body.effectiveOn }),
    ...(body.expectedTotal === null ? {} : { p_expected_total: body.expectedTotal }),
    p_confirm_status: body.confirmStatus,
    p_confirm_unit: body.confirmUnit,
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("habits.tracking_failed", error);
  const row = data[0];
  if (row?.outcome === "unchanged") {
    return failure(409, "unchanged", { revision: row.revision });
  }
  return outcomeAnswer(
    "habits.tracking_failed",
    row?.outcome,
    { outcome: row?.outcome, impact: row?.impact ?? null, revision: row?.revision ?? null },
    { revision: row?.revision, impact: row?.impact },
  );
}
