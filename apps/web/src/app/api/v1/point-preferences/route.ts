import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import {
  databaseFailure,
  failure,
  json,
  readChoreMutation,
  requireReader,
  SMALL_BODY_BYTES,
} from "@/chores/route-helpers";
import { getPointSummary } from "@/points/data";
import { pointPreferencesSchema } from "@/points/schema";

/** The caller's own points choices in one Home (S23): participation and weekly target. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const summary = await getPointSummary(homeId.data);
  if (summary.status === "not-found") return failure(404, "not-found");
  if (summary.status === "unavailable") return failure(500, "failed");
  const { participates, target, targetPaused, shareTarget } = summary.value;
  return json(200, { participates, target, targetPaused, shareTarget });
}

/**
 * Saves the caller's own choices (S23; any member, never someone else's): whether they appear on
 * the leaderboard and the shared weekly overview, their weekly target (null or 0 removes it), a
 * pause, and whether others see the target. Each part is optional.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, pointPreferencesSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const prefs = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_point_preferences", {
    p_home_id: prefs.homeId,
    ...(prefs.participates !== undefined ? { p_participates: prefs.participates } : {}),
    p_set_target: prefs.target !== undefined,
    ...(prefs.target !== undefined && prefs.target !== null ? { p_target: prefs.target } : {}),
    ...(prefs.targetPaused !== undefined ? { p_target_paused: prefs.targetPaused } : {}),
    ...(prefs.shareTarget !== undefined ? { p_share_target: prefs.shareTarget } : {}),
  });
  if (error) return databaseFailure("points.preferences_failed", error);
  return json(200, { outcome: data });
}
