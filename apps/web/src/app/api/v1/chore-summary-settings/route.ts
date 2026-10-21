import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getManagerSummarySetting } from "@/chores/data";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { summarySettingSchema } from "@/chores/schema";
import { personalTimeZone } from "@/tasks/reminder-data";

/** The caller's daily chore summary setting for a Home (S21): off, or on at an hour. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const setting = await getManagerSummarySetting(homeId.data);
  if (setting.status === "not-found") return failure(404, "not-found");
  if (setting.status === "unavailable") return failure(500, "failed");
  return json(200, setting.value);
}

/**
 * Turns the caller's daily summary for a Home on or off (chore managers, `403 not-permitted`
 * otherwise), at an hour in their own timezone, which the server resolves as for personal reminders.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, summarySettingSchema);
  if (!input.ok) return input.response;
  const setting = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_chore_summary_setting", {
    p_home_id: setting.homeId,
    p_enabled: setting.enabled,
    p_hour: setting.hour,
    p_time_zone: await personalTimeZone(),
    p_expected_revision: setting.expectedRevision,
  });
  if (error) return databaseFailure("chores.summary_setting_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.summary_setting_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
