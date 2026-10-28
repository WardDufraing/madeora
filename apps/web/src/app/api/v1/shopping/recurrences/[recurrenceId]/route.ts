import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getEffectiveTimeZone } from "@/preferences/server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { updateRecurrenceSchema } from "@/shopping/schema";

interface RecurrenceRouteContext {
  readonly params: Promise<{ readonly recurrenceId: string }>;
}

/**
 * Changes a recurring rule (editors; revision-checked): a new schedule (and, with `fromItemId`, the
 * details of its current item), applying from the next occurrence; Pause; Resume (from today,
 * never catching up); Stop repeating (its items and their history stay).
 */
export async function PATCH(
  request: Request,
  { params }: RecurrenceRouteContext,
): Promise<Response> {
  const input = await readShoppingMutation(request, updateRecurrenceSchema);
  if (!input.ok) return input.response;
  const recurrenceId = pathId((await params).recurrenceId);
  if (!recurrenceId) return failure(404, "not-found");
  const body = input.data;
  const supabase = await createSupabaseServerClient();
  const schedule =
    body.action === "schedule"
      ? {
          p_frequency: body.schedule.frequency,
          ...(body.schedule.weekdays ? { p_weekdays: [...body.schedule.weekdays] } : {}),
          ...(body.schedule.monthDay ? { p_month_day: body.schedule.monthDay } : {}),
          ...(body.schedule.startOn ? { p_start_on: body.schedule.startOn } : {}),
          ...(body.fromItemId ? { p_template_item_id: body.fromItemId } : {}),
          p_time_zone: (await getEffectiveTimeZone()).timeZone,
        }
      : {};
  const { data, error } = await supabase.rpc("update_shopping_recurrence", {
    p_id: recurrenceId,
    p_expected_revision: body.revision,
    p_action: body.action,
    ...schedule,
  });
  if (error) return databaseFailure("shopping.update_recurrence_failed", error);
  const row = data[0];
  return outcomeAnswer(
    "shopping.update_recurrence_failed",
    row?.outcome,
    { id: recurrenceId, revision: row?.revision ?? null, nextOn: row?.next_on ?? null },
    row?.revision,
  );
}
