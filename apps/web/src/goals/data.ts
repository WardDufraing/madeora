import "server-only";

import { cache } from "react";
import type { z } from "zod";

import type { GoalView } from "@madeora/domain/goals";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import { logGoals } from "./log";
import {
  goalDetailSchema,
  goalEntriesSchema,
  goalEventsSchema,
  goalListSchema,
  goalSeriesDetailSchema,
  goalSeriesPeriodsSchema,
  type GoalDetail,
  type GoalEntries,
  type GoalEvents,
  type GoalList,
  type GoalSeriesDetail,
  type GoalSeriesPeriods,
} from "./shapes";

/**
 * Server reads of goals (S30), always with the signed-in person's own Supabase session: the
 * database answers only what they may see now, so a Home they left or someone else's personal goal
 * is simply not there. Every answer is checked against its shape; nothing is cached across requests
 * (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  /** Not a Home the person belongs to, no such goal, or not theirs to see. */
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  if (error.code === "22023" || error.code === "22P02") return { status: "invalid" };
  logGoals(event, error.code);
  return { status: "unavailable" };
}

/** A JSON answer checked against its shape; null (the database's "not visible") is not found. */
function parsed<S extends z.ZodType>(event: string, schema: S, data: unknown): Read<z.output<S>> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logGoals(event, "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

/**
 * Rolls the recurring series of a context (or one series) whose period changed since they were last
 * rolled (S30b), so a read sees the period running now even before the hourly background run. Best
 * effort: a failure is logged and the read goes on (the background run catches up).
 */
async function syncGoalPeriods(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  target: { readonly homeId: string | null } | { readonly seriesId: string },
): Promise<void> {
  const { error } = await supabase.rpc(
    "sync_goal_periods",
    "seriesId" in target
      ? { p_series_id: target.seriesId }
      : target.homeId
        ? { p_home_id: target.homeId }
        : {},
  );
  if (error && error.code !== "42501") logGoals("goals.sync_failed", error.code);
}

/** The goals of a context in one view, with its counts, its series, the person's access and settings. */
export async function readGoals(
  homeId: string | null,
  view: GoalView = "active",
  query: string | null = null,
): Promise<Read<GoalList>> {
  const supabase = await createSupabaseServerClient();
  await syncGoalPeriods(supabase, { homeId });
  const { data, error } = await supabase.rpc("get_goals", {
    ...(homeId ? { p_home_id: homeId } : {}),
    p_view: view,
    ...(query ? { p_query: query } : {}),
  });
  if (error) return failed("goals.list_failed", error);
  return parsed("goals.list_unexpected_shape", goalListSchema, data);
}

/** One goal with everything its page shows (read once per request: title and page share it). */
export const readGoal = cache(async (goalId: string): Promise<Read<GoalDetail>> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_goal", { p_goal_id: goalId });
  if (error) return failed("goals.detail_failed", error);
  return parsed("goals.detail_unexpected_shape", goalDetailSchema, data);
});

/** One recurring series with everything its page shows (read once per request). */
export const readGoalSeries = cache(async (seriesId: string): Promise<Read<GoalSeriesDetail>> => {
  const supabase = await createSupabaseServerClient();
  await syncGoalPeriods(supabase, { seriesId });
  const { data, error } = await supabase.rpc("get_goal_series", { p_series_id: seriesId });
  if (error) return failed("goals.series_failed", error);
  return parsed("goals.series_unexpected_shape", goalSeriesDetailSchema, data);
});

/** A page of a series' periods (newest first) after the period `before` (none: the newest). */
export async function readGoalSeriesPeriods(
  seriesId: string,
  before: string | null,
): Promise<Read<GoalSeriesPeriods>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_goal_series_periods", {
    p_series_id: seriesId,
    ...(before ? { p_before: before } : {}),
  });
  if (error) return failed("goals.series_periods_failed", error);
  return parsed("goals.series_periods_unexpected_shape", goalSeriesPeriodsSchema, data);
}

/** A page of a goal's entries after the entry `before` (none: the newest). */
export async function readGoalEntries(
  goalId: string,
  before: string | null,
): Promise<Read<GoalEntries>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_goal_entries", {
    p_goal_id: goalId,
    ...(before ? { p_before: before } : {}),
  });
  if (error) return failed("goals.entries_failed", error);
  return parsed("goals.entries_unexpected_shape", goalEntriesSchema, data);
}

/** A page of a goal's history after the event `before` (none: the newest). */
export async function readGoalEvents(
  goalId: string,
  before: string | null,
): Promise<Read<GoalEvents>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_goal_events", {
    p_goal_id: goalId,
    ...(before ? { p_before: before } : {}),
  });
  if (error) return failed("goals.events_failed", error);
  return parsed("goals.events_unexpected_shape", goalEventsSchema, data);
}

/** The titles of goals notifications point at, only those the person may still see. */
export async function goalNoticeNames(
  goalIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (goalIds.length === 0) return new Map();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("goal_notice_names", {
    p_goal_ids: [...new Set(goalIds)].slice(0, 100),
  });
  if (error) {
    logGoals("goals.notice_names_failed", error.code);
    return new Map();
  }
  return new Map(data.map((row) => [row.goal_id, row.title]));
}
