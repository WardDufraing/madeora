import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { displayLockStateSchema } from "@/displays/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 1024;

interface LockRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly displayId: string }>;
}

/**
 * Locks or unlocks one display's privacy/party mode, with its lock screen's welcome message, from a
 * manager's own session (S44). This is the only way to unlock a display.
 */
export async function POST(request: Request, { params }: LockRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, displayLockStateSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, displayId } = await params;
  if (!z.uuid().safeParse(displayId).success) return failure(404, "not-found");
  const allowed = await requireHomeAction(homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_household_display_lock", {
    p_home_id: allowed.context.home.id,
    p_display_id: displayId,
    p_locked: input.data.locked,
    ...(input.data.message === null ? {} : { p_message: input.data.message }),
  });
  if (error) return databaseFailure("household_displays.lock_failed", error.code);
  return data === "saved" || data === "unchanged" ? json(200, {}) : outcomeFailure(data);
}
