import { getPublicEnv } from "@madeora/config/env/public";
import { cookies } from "next/headers";

import { isSameOriginRequest } from "@/auth/same-origin";
import { getVerifiedIdentity } from "@/auth/identity";
import { signInPath } from "@/auth/redirects";
import { settingsPath } from "@/google-calendar/schema";
import {
  STATE_COOKIE,
  STATE_MAX_AGE_SECONDS,
  getGoogleCalendarServer,
  newConnectAttempt,
  sealConnectAttempt,
  stateCookieOptions,
} from "@/google-calendar/server";

const noStore = { "Cache-Control": "no-store" };

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, ...noStore } });
}

/**
 * Starts connecting Google Calendar (S33): a same-origin form POST by a signed-in person (CSRF,
 * architecture.md §7). Creates a fresh state and PKCE verifier, keeps them sealed in an httpOnly
 * cookie bound to this person for 10 minutes, and sends the browser to Google's consent screen.
 * Signing in with Google never comes here: connecting a calendar is always this explicit step.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, getPublicEnv().NEXT_PUBLIC_APP_URL)) {
    return new Response(null, { status: 403, headers: noStore });
  }
  const identity = await getVerifiedIdentity();
  if (!identity) return redirect(signInPath(settingsPath));
  const google = getGoogleCalendarServer();
  if (!google) return redirect(`${settingsPath}?google=unavailable`);
  const attempt = newConnectAttempt(identity.userId, new Date());
  (await cookies()).set(
    STATE_COOKIE,
    sealConnectAttempt(attempt, google.tokenKey),
    stateCookieOptions(STATE_MAX_AGE_SECONDS),
  );
  return redirect(
    google.client.authorizationUrl({
      redirectUri: google.redirectUri,
      state: attempt.state,
      codeChallenge: attempt.challenge,
    }),
  );
}
