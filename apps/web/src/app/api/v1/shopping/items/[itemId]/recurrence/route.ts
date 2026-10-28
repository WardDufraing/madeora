import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getEffectiveTimeZone } from "@/preferences/server";
import {
  databaseFailure,
  failure,
  outcomeAnswer,
  pathId,
  readShoppingMutation,
} from "@/shopping/route-helpers";
import { startRecurrenceSchema } from "@/shopping/schema";

interface ItemRouteContext {
  readonly params: Promise<{ readonly itemId: string }>;
}

/**
 * Starts repeating an active item (editors): the rule takes the item's details and this item
 * stands for today's occurrence. A Personal list's rule keeps the person's effective timezone; a
 * Home's uses the Home's. The rule's id comes from the client, so a retry answers the same rule.
 */
export async function POST(request: Request, { params }: ItemRouteContext): Promise<Response> {
  const input = await readShoppingMutation(request, startRecurrenceSchema);
  if (!input.ok) return input.response;
  const itemId = pathId((await params).itemId);
  if (!itemId) return failure(404, "not-found");
  const { schedule } = input.data;
  const [supabase, zone] = await Promise.all([
    createSupabaseServerClient(),
    getEffectiveTimeZone(),
  ]);
  const { data, error } = await supabase.rpc("start_shopping_recurrence", {
    p_item_id: itemId,
    p_id: input.data.id,
    p_frequency: schedule.frequency,
    ...(schedule.weekdays ? { p_weekdays: [...schedule.weekdays] } : {}),
    ...(schedule.monthDay ? { p_month_day: schedule.monthDay } : {}),
    ...(schedule.startOn ? { p_start_on: schedule.startOn } : {}),
    p_time_zone: zone.timeZone,
  });
  if (error) return databaseFailure("shopping.start_recurrence_failed", error);
  const row = data[0];
  // Here `completed` is a refusal: a checked-off item cannot start repeating.
  if (row?.outcome === "completed") return failure(409, "completed");
  return outcomeAnswer("shopping.start_recurrence_failed", row?.outcome, {
    id: input.data.id,
    revision: row?.revision ?? null,
    nextOn: row?.next_on ?? null,
  });
}
