import "server-only";

import type { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getEffectiveTimeZone } from "@/preferences/server";

import { logCalendar } from "./log";
import {
  calendarAccessListSchema,
  calendarListSchema,
  eventDetailSchema,
  upcomingSchema,
  type CalendarAccessList,
  type CalendarList,
  type EventDetail,
  type Upcoming,
} from "./shapes";

/**
 * Server reads of the calendar (S32), always with the signed-in person's own Supabase session: the
 * database answers only what they may see now, in the context they ask for. An event that is not
 * theirs to see answers "not found", exactly like one that does not exist. The Personal space is
 * shown in the person's effective timezone (the database cannot know a device's zone); a Home in its
 * own. Every answer is checked against its shape; nothing is cached across requests (personalized
 * data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  if (error.code === "22023" || error.code === "22P02") return { status: "invalid" };
  logCalendar(event, error.code);
  return { status: "unavailable" };
}

function parsed<S extends z.ZodType>(event: string, schema: S, data: unknown): Read<z.output<S>> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logCalendar(event, "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

/** The context arguments: a Home, or the Personal space with the person's own timezone. */
async function contextArgs(
  homeId: string | null,
): Promise<{ p_home_id: string } | { p_zone: string }> {
  return homeId === null
    ? { p_zone: (await getEffectiveTimeZone()).timeZone }
    : { p_home_id: homeId };
}

/** The occurrences a person sees in a context (null: Personal) over local dates [from, to]. */
export async function readCalendar(
  homeId: string | null,
  from: string,
  to: string,
): Promise<Read<CalendarList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_calendar", {
    p_from: from,
    p_to: to,
    ...(await contextArgs(homeId)),
  });
  if (error) return failed("calendar.list_failed", error);
  return parsed("calendar.list_failed", calendarListSchema, data);
}

/** The Upcoming events widget's rows in a context. */
export async function readUpcoming(
  homeId: string | null,
  days: number,
  count: number,
): Promise<Read<Upcoming>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_calendar_upcoming", {
    p_days: days,
    p_count: count,
    ...(await contextArgs(homeId)),
  });
  if (error) return failed("calendar.upcoming_failed", error);
  return parsed("calendar.upcoming_failed", upcomingSchema, data);
}

/** One event in a context, with the occurrence on `on` for a recurring one. */
export async function readEvent(
  eventId: string,
  homeId: string | null,
  on: string | null,
): Promise<Read<EventDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_calendar_event", {
    p_event_id: eventId,
    ...(on === null ? {} : { p_on: on }),
    ...(await contextArgs(homeId)),
  });
  if (error) return failed("calendar.event_failed", error);
  return parsed("calendar.event_failed", eventDetailSchema, data);
}

/** The members' calendar levels (managers see everyone; others only themselves). */
export async function readCalendarAccess(homeId: string): Promise<Read<CalendarAccessList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_calendar_access", { p_home_id: homeId });
  if (error) return failed("calendar.access_failed", error);
  return parsed("calendar.access_failed", calendarAccessListSchema, data);
}
