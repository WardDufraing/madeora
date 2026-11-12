import { z } from "zod";

import { getAuthState } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { displayJson, readDisplayRequest } from "@/displays/route-helpers";
import { getDisplaySession } from "@/displays/server";

const MAX_BODY_BYTES = 16;

/**
 * Clears a display session the database no longer accepts (S43: revoked, Home closed), so the
 * tablet can show the pairing screen again. A display that still works is never signed out here:
 * leaving display mode is a Home manager's decision, made from their own session.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  if ((await getAuthState()).kind !== "display") return displayJson(200, {});
  const result = await getDisplaySession();
  if (result.kind === "ok") return displayJson(409, { error: "paired" });
  if (result.kind === "unavailable") return displayJson(503, { error: "unavailable" });
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  return displayJson(200, {});
}
