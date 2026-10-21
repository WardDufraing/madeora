import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getChoreSettings } from "@/chores/data";
import {
  databaseFailure,
  failure,
  json,
  nullable,
  outcomeAnswer,
  readChoreMutation,
  requireReader,
} from "@/chores/route-helpers";
import { choreSettingsSchema } from "@/chores/schema";

/** The Home's chore settings (S21): week start and reassignment confirmation, for every member. */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const settings = await getChoreSettings(homeId.data);
  if (settings.status === "not-found") return failure(404, "not-found");
  if (settings.status === "unavailable") return failure(500, "failed");
  return json(200, { settings: settings.value });
}

/** Changes them (chore managers); `expectedRevision` 0 while they were never changed. */
export async function PATCH(request: Request): Promise<Response> {
  const input = await readChoreMutation(request, choreSettingsSchema);
  if (!input.ok) return input.response;
  const change = input.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_chore_settings", {
    p_home_id: change.homeId,
    p_expected_revision: change.expectedRevision,
    p_week_start: change.weekStart,
    p_reassignment_confirmation: change.reassignmentConfirmation,
  });
  if (error) return databaseFailure("chores.settings_failed", error);
  const row = data[0];
  const revision = row ? nullable(row.revision) : null;
  return outcomeAnswer(
    "chores.settings_failed",
    row?.outcome,
    { outcome: row?.outcome, revision },
    { revision },
  );
}
