import "server-only";

import { cache } from "react";
import type { z } from "zod";

import type { HabitView } from "@madeora/domain/habits";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import { logHabits } from "./log";
import {
  habitCalendarSchema,
  habitCheckinSchema,
  habitDetailSchema,
  habitEventSchema,
  habitInsightsSchema,
  habitListSchema,
  vacationHabitsSchema,
  type HabitCalendar,
  type HabitCheckin,
  type HabitDetail,
  type HabitEvent,
  type HabitInsights,
  type HabitList,
  type VacationHabits,
} from "./shapes";

/**
 * Server reads of habits (S28), always with the signed-in person's own Supabase session: the
 * database answers only what they may see now, so a Home they left or someone else's personal habit
 * is simply not there. Every answer is checked against its shape; nothing is cached across requests
 * (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  /** Not a Home the person belongs to, no such habit, or not theirs to see. */
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  if (error.code === "22023" || error.code === "22P02") return { status: "invalid" };
  logHabits(event, error.code);
  return { status: "unavailable" };
}

/** A JSON answer checked against its shape; null (the database's "not visible") is not found. */
function parsed<S extends z.ZodType>(event: string, schema: S, data: unknown): Read<z.output<S>> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logHabits(event, "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

/** The habits of a context in one view, with its counts, the person's access and settings. */
export async function readHabits(
  homeId: string | null,
  view: HabitView = "active",
  query: string | null = null,
): Promise<Read<HabitList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_habits", {
    ...(homeId ? { p_home_id: homeId } : {}),
    p_view: view,
    ...(query ? { p_query: query } : {}),
  });
  if (error) return failed("habits.list_failed", error);
  return parsed("habits.list_unexpected_shape", habitListSchema, data);
}

/** One habit with everything its page shows (read once per request: title and page share it). */
export const readHabit = cache(async (habitId: string): Promise<Read<HabitDetail>> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_habit", { p_habit_id: habitId });
  if (error) return failed("habits.detail_failed", error);
  return parsed("habits.detail_unexpected_shape", habitDetailSchema, data);
});

export async function readHabitInsights(
  habitId: string,
  days: number,
): Promise<Read<HabitInsights>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_habit_insights", {
    p_habit_id: habitId,
    p_days: days,
  });
  if (error) return failed("habits.insights_failed", error);
  return parsed("habits.insights_unexpected_shape", habitInsightsSchema, data);
}

/** A month (`YYYY-MM`) of a habit. */
export async function readHabitCalendar(
  habitId: string,
  month: string,
): Promise<Read<HabitCalendar>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_habit_calendar", {
    p_habit_id: habitId,
    p_month: `${month}-01`,
  });
  if (error) return failed("habits.calendar_failed", error);
  return parsed("habits.calendar_unexpected_shape", habitCalendarSchema, data);
}

/** A page of check-ins after the check-in `before` (none: the newest). */
export async function readHabitCheckins(
  habitId: string,
  before: string | null,
): Promise<Read<readonly HabitCheckin[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_habit_checkins", {
    p_habit_id: habitId,
    ...(before ? { p_before: before } : {}),
  });
  if (error) return failed("habits.checkins_failed", error);
  return parsed("habits.checkins_unexpected_shape", habitCheckinSchema.array(), data);
}

/** A page of the habit's history after the event `before` (none: the newest). */
export async function readHabitEvents(
  habitId: string,
  before: string | null,
): Promise<Read<readonly HabitEvent[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_habit_events", {
    p_habit_id: habitId,
    ...(before ? { p_before: before } : {}),
  });
  if (error) return failed("habits.events_failed", error);
  return parsed("habits.events_unexpected_shape", habitEventSchema.array(), data);
}

/** The person's own personal habits for one vacation, and their participation in it. */
export async function readVacationHabits(vacationId: string): Promise<Read<VacationHabits>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_vacation_habits", {
    p_vacation_id: vacationId,
  });
  if (error) return failed("habits.vacation_failed", error);
  return parsed("habits.vacation_unexpected_shape", vacationHabitsSchema, data);
}

/** The names of habits notifications point at, only those the person may still see. */
export async function habitNoticeNames(
  habitIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (habitIds.length === 0) return new Map();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("habit_notice_names", {
    p_habit_ids: [...new Set(habitIds)].slice(0, 100),
  });
  if (error) {
    logHabits("habits.notice_names_failed", error.code);
    return new Map();
  }
  return new Map(data.map((row) => [row.habit_id, row.name]));
}
