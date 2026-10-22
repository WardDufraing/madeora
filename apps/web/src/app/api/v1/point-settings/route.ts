import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { getPointSummary } from "@/points/data";
import { pointSettingsSchema } from "@/points/schema";

/** The Home's leaderboard settings (S23; every member reads them). */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const summary = await getPointSummary(homeId.data);
  if (summary.status === "not-found") return failure(404, "not-found");
  if (summary.status === "unavailable") return failure(500, "failed");
  const { leaderboardEnabled, defaultPeriod, canManageRewards } = summary.value;
  return json(200, { leaderboardEnabled, defaultPeriod, canChange: canManageRewards });
}

/** Turns the leaderboard on or off and sets its default period (S23; rewards managers). */
export async function PUT(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, pointSettingsSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const settings = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_point_settings", {
    p_home_id: settings.homeId,
    p_leaderboard_enabled: settings.leaderboardEnabled,
    p_default_period: settings.defaultPeriod,
  });
  if (error) return databaseFailure("points.settings_failed", error);
  return outcomeAnswer("points.settings_failed", data, { outcome: data });
}
