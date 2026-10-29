import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoals } from "@/goals/log";
import { databaseFailure, failure, outcomeAnswer, readGoalMutation } from "@/goals/route-helpers";
import { createSeriesSchema } from "@/goals/schema";
import { goalSeriesCreateResultSchema } from "@/goals/shapes";
import { getEffectiveTimeZone } from "@/preferences/server";

/**
 * Creates a recurring goal series (a personal series; a Home series: goal managers), or with
 * `preview: true` answers its first and next periods. The first period is this period or a later
 * one (`409 invalid-dates` otherwise: nothing is backfilled); the period running now is created at
 * once. A personal series without a timezone takes the person's effective one.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readGoalMutation(request, createSeriesSchema);
  if (!input.ok) return input.response;
  const body = input.data;
  const timeZone =
    body.homeId === null ? (body.timeZone ?? (await getEffectiveTimeZone()).timeZone) : null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_goal_series", {
    p_id: body.id,
    ...(body.homeId ? { p_home_id: body.homeId } : {}),
    p_kind: body.kind,
    p_frequency: body.frequency,
    p_title: body.title,
    ...(body.description === null ? {} : { p_description: body.description }),
    ...(body.measure === null
      ? {}
      : {
          p_target: body.measure.target,
          p_unit: body.measure.unit,
          p_unit_kind: body.measure.unitKind,
        }),
    p_week_start: body.weekStart,
    p_first_period: body.firstPeriod,
    ...(body.endsOn === null ? {} : { p_ends_on: body.endsOn }),
    ...(timeZone === null ? {} : { p_time_zone: timeZone }),
    ...(body.reminder === null
      ? {}
      : { p_reminder_lead_days: body.reminder.leadDays, p_reminder_at_time: body.reminder.atTime }),
    p_dry_run: body.preview,
  });
  if (error) return databaseFailure("goals.series_create_failed", error);
  const result = goalSeriesCreateResultSchema.safeParse(data);
  if (!result.success) {
    logGoals("goals.series_create_unexpected_shape", "shape");
    return failure(500, "failed");
  }
  const value = result.data;
  return outcomeAnswer("goals.series_create_failed", value.outcome, { id: body.id, ...value });
}
