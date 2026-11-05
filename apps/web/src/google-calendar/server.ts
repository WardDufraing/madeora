import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { getPublicEnv } from "@madeora/config/env/public";
import {
  createGoogleCalendarClient,
  googleCalendarConfigFromEnv,
  open,
  parseGoogleCalendarEnv,
  seal,
  type GoogleCalendarClient,
} from "@madeora/google-calendar";
import { z } from "zod";

/**
 * The web server's side of Google Calendar (S33, ADR 0043): the OAuth client of the separate Calendar
 * project (never Google sign-in's), the token key, and the short-lived state of one connect attempt.
 * Server-only: the client secret and the key never reach browser code.
 */

export interface GoogleCalendarServer {
  readonly client: GoogleCalendarClient;
  readonly tokenKey: Buffer;
  readonly redirectUri: string;
}

let cached: GoogleCalendarServer | null | undefined;

/** Null when Google Calendar is not configured in this environment. */
export function getGoogleCalendarServer(): GoogleCalendarServer | null {
  if (cached !== undefined) return cached;
  const config = googleCalendarConfigFromEnv(parseGoogleCalendarEnv(process.env));
  cached = config
    ? {
        client: createGoogleCalendarClient(config),
        tokenKey: config.tokenKey,
        redirectUri: new URL(CALLBACK_PATH, getPublicEnv().NEXT_PUBLIC_APP_URL).toString(),
      }
    : null;
  return cached;
}

/** For tests: forget the cached settings. */
export function resetGoogleCalendarServer(): void {
  cached = undefined;
}

export const CALLBACK_PATH = "/api/v1/integrations/google-calendar/callback";
export const STATE_COOKIE = "madeora-google-calendar-oauth";
/** How long a connect attempt may take. */
export const STATE_MAX_AGE_SECONDS = 600;
const STATE_PURPOSE = "madeora:google-calendar:oauth-state";

const stateSchema = z.strictObject({
  state: z.string().min(43).max(64),
  verifier: z.string().min(43).max(128),
  userId: z.uuid(),
  expiresAt: z.int(),
});
export type ConnectAttempt = z.output<typeof stateSchema>;

/** A new attempt: the state Google returns, the PKCE verifier and its S256 challenge. */
export function newConnectAttempt(
  userId: string,
  now: Date,
): ConnectAttempt & { readonly challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(32).toString("base64url"),
    verifier,
    userId,
    expiresAt: Math.floor(now.getTime() / 1000) + STATE_MAX_AGE_SECONDS,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** The cookie value: the attempt sealed with the token key, so the browser can neither read nor change it. */
export function sealConnectAttempt(attempt: ConnectAttempt, key: Buffer): string {
  const { state, verifier, userId, expiresAt } = attempt;
  return seal(JSON.stringify({ state, verifier, userId, expiresAt }), key, STATE_PURPOSE);
}

/**
 * The attempt this callback belongs to: the cookie opens, has not expired, was started by the person
 * signed in now, and its state equals the one Google returned. Null otherwise.
 */
export function openConnectAttempt(input: {
  readonly cookie: string | undefined;
  readonly returnedState: string | null;
  readonly userId: string;
  readonly key: Buffer;
  readonly now: Date;
}): ConnectAttempt | null {
  if (!input.cookie || !input.returnedState) return null;
  let parsed: ConnectAttempt;
  try {
    const value = stateSchema.safeParse(JSON.parse(open(input.cookie, input.key, STATE_PURPOSE)));
    if (!value.success) return null;
    parsed = value.data;
  } catch {
    return null;
  }
  if (parsed.expiresAt < Math.floor(input.now.getTime() / 1000)) return null;
  if (parsed.userId !== input.userId) return null;
  const expected = Buffer.from(parsed.state);
  const returned = Buffer.from(input.returnedState);
  if (expected.length !== returned.length || !timingSafeEqual(expected, returned)) return null;
  return parsed;
}

/** Cookie options: httpOnly, only for the callback path, secure on https, sent on Google's redirect back (Lax). */
export function stateCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: getPublicEnv().NEXT_PUBLIC_APP_URL.startsWith("https://"),
    sameSite: "lax" as const,
    path: CALLBACK_PATH,
    maxAge,
  };
}
