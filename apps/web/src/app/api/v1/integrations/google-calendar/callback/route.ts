import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleAuthorizationError,
  sealRefreshToken,
} from "@madeora/google-calendar";
import { cookies } from "next/headers";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { logGoogleCalendar } from "@/google-calendar/data";
import { settingsPath, type ConnectNotice } from "@/google-calendar/schema";
import {
  STATE_COOKIE,
  getGoogleCalendarServer,
  openConnectAttempt,
  stateCookieOptions,
} from "@/google-calendar/server";

function back(notice: ConnectNotice): Response {
  // A relative address keeps the browser on the origin it used.
  return new Response(null, {
    status: 303,
    headers: { Location: `${settingsPath}?google=${notice}`, "Cache-Control": "no-store" },
  });
}

/**
 * Google's answer to a connect attempt (S33). Accepted only for the attempt this browser started (the
 * sealed state cookie), by the same signed-in person, within 10 minutes; the cookie is used once. The
 * code is exchanged with the PKCE verifier; both calendar scopes must have been granted and a refresh
 * token returned, or the grant is revoked again. The refresh token is sealed (AES-256-GCM, bound to
 * the person) and stored with the person's own session; it never reaches the browser or a log.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cookieStore = await cookies();
  const sealed = cookieStore.get(STATE_COOKIE)?.value;
  // One use only, whatever happens next.
  cookieStore.set(STATE_COOKIE, "", stateCookieOptions(0));

  const google = getGoogleCalendarServer();
  if (!google) return back("unavailable");
  const identity = await getVerifiedIdentity();
  if (!identity) return back("state");
  const attempt = openConnectAttempt({
    cookie: sealed,
    returnedState: url.searchParams.get("state"),
    userId: identity.userId,
    key: google.tokenKey,
    now: new Date(),
  });
  if (!attempt) return back("state");
  if (url.searchParams.get("error")) return back("cancelled");
  const supabase = await createSupabaseServerClient();
  // S38: a verified attempt that fails is a "Google Calendar connection failed" entry in the
  // person's own activity history (a cancelled one is not). Best effort: never blocks the answer.
  const fail = async (notice: ConnectNotice): Promise<Response> => {
    try {
      const result = await supabase.rpc("record_integration_failure", {
        p_provider: "google_calendar",
      });
      if (result.error) {
        logGoogleCalendar("google_calendar.failure_not_recorded", result.error.code);
      }
    } catch {
      logGoogleCalendar("google_calendar.failure_not_recorded");
    }
    return back(notice);
  };
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return fail("failed");

  let grant;
  try {
    grant = await google.client.exchangeCode({
      code,
      codeVerifier: attempt.verifier,
      redirectUri: google.redirectUri,
    });
  } catch (error) {
    logGoogleCalendar(
      "google_calendar.exchange_failed",
      error instanceof GoogleAuthorizationError ? error.code : "error",
    );
    return fail("failed");
  }

  const revokeGrant = async () => {
    try {
      await google.client.revoke(grant.refreshToken ?? grant.accessToken);
    } catch {
      logGoogleCalendar("google_calendar.revoke_failed");
    }
  };
  if (!GOOGLE_CALENDAR_SCOPES.every((scope) => grant.scopes.includes(scope))) {
    await revokeGrant();
    return fail("missing_scope");
  }
  if (!grant.refreshToken) {
    await revokeGrant();
    return fail("failed");
  }

  let account: string;
  try {
    account = await google.client.primaryCalendarId(grant.accessToken);
  } catch {
    logGoogleCalendar("google_calendar.primary_failed");
    await revokeGrant();
    return fail("failed");
  }

  const { data, error } = await supabase.rpc("save_google_calendar_connection", {
    p_account: account,
    p_token: sealRefreshToken(grant.refreshToken, google.tokenKey, identity.userId),
    p_scopes: grant.scopes.filter((scope) => scope.length <= 200).slice(0, 10),
  });
  if (error || (data !== "connected" && data !== "reconnected" && data !== "replaced")) {
    logGoogleCalendar("google_calendar.save_failed", error?.code ?? "unexpected_outcome");
    await revokeGrant();
    return fail("failed");
  }
  return back(data);
}
