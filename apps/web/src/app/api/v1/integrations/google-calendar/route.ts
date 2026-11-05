import { GoogleHttpError, openRefreshToken } from "@madeora/google-calendar";
import { z } from "zod";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoogleCalendar, readGoogleConnection } from "@/google-calendar/data";
import {
  databaseFailure,
  failure,
  json,
  readGoogleMutation,
} from "@/google-calendar/route-helpers";
import { emptyBodySchema } from "@/google-calendar/schema";
import { getGoogleCalendarServer } from "@/google-calendar/server";

/** The person's own connection (null when not connected); never a token. */
export async function GET(): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const read = await readGoogleConnection();
  if (read.status !== "ok") return failure(500, "failed");
  return json(200, { connection: read.value });
}

/**
 * Disconnect (S33): removes the connection with everything synced from it (the database hands back the
 * sealed token once), then revokes the token at Google. When Google cannot be reached the connection is
 * still gone from Madeora, and the answer says so (`revoked: false`), so the page can point to Google's
 * own permissions page.
 */
export async function DELETE(request: Request): Promise<Response> {
  const input = await readGoogleMutation(request, emptyBodySchema);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("disconnect_google_calendar");
  if (error) return databaseFailure("google_calendar.disconnect_failed", error);
  // The sealed token, or null when nothing was connected (the generated types say only text).
  const parsed = z.string().min(1).nullable().safeParse(data);
  if (!parsed.success)
    return databaseFailure("google_calendar.disconnect_failed", { code: "shape" });
  const sealed = parsed.data;
  if (sealed === null) return json(200, { outcome: "not_connected" });
  const google = getGoogleCalendarServer();
  let revoked = false;
  if (google) {
    try {
      await google.client.revoke(openRefreshToken(sealed, google.tokenKey, input.identity.userId));
      revoked = true;
    } catch (cause) {
      logGoogleCalendar(
        "google_calendar.revoke_failed",
        cause instanceof GoogleHttpError ? String(cause.status) : "error",
      );
    }
  }
  return json(200, { outcome: "disconnected", revoked });
}
