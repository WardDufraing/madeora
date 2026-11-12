import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { renameDisplaySchema } from "@/displays/schema";
import {
  databaseFailure,
  failure,
  json,
  outcomeFailure,
  readMemberMutation,
  requireHomeAction,
} from "@/members/manage-server";

const MAX_BODY_BYTES = 256;

interface RenameRouteContext {
  readonly params: Promise<{ readonly homeId: string; readonly displayId: string }>;
}

/** Renames an active Household Display (S43). Same managers as pairing. */
export async function POST(request: Request, { params }: RenameRouteContext): Promise<Response> {
  const input = await readMemberMutation(request, renameDisplaySchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const { homeId, displayId } = await params;
  if (!z.uuid().safeParse(displayId).success) return failure(404, "not-found");
  const allowed = await requireHomeAction(homeId, "home.updateSettings");
  if (!allowed.ok) return allowed.response;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rename_household_display", {
    p_home_id: allowed.context.home.id,
    p_display_id: displayId,
    p_name: input.data.name,
  });
  if (error) return databaseFailure("household_displays.rename_failed", error.code);
  return data === "saved" || data === "unchanged" ? json(200, {}) : outcomeFailure(data);
}
