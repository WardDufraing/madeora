import { isAuthError, type Factor, type User } from "@supabase/supabase-js";

/**
 * Optional two-factor sign-in with an authenticator app (S37, spec "Confirmed optional adult
 * two-factor authentication"). Supabase Auth runs the TOTP factor; the database enforces when it
 * may be added or removed and limits attempts (supabase/migrations/20261123090000_adult_security.sql).
 * These helpers are safe on the server and in the browser.
 */

/** The account's verified authenticator, if two-factor sign-in is on. */
export function verifiedTotpFactor(user: Pick<User, "factors">): Factor | null {
  return (
    user.factors?.find((factor) => factor.factor_type === "totp" && factor.status === "verified") ??
    null
  );
}

/** Claims Madeora reads from an access token that Supabase Auth has already accepted. */
export interface AccessTokenClaims {
  readonly aal: string | null;
  readonly sessionId: string | null;
}

/**
 * Reads the payload of a JWT without checking it. Only for a token Supabase Auth has just
 * confirmed (`auth.getUser(token)`), or for display in the browser; never as proof of anything.
 */
export function readAccessTokenClaims(token: string): AccessTokenClaims {
  const payload = token.split(".")[1];
  if (!payload) return { aal: null, sessionId: null };
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    if (typeof json !== "object" || json === null) return { aal: null, sessionId: null };
    const record = json as Record<string, unknown>;
    return {
      aal: typeof record.aal === "string" ? record.aal : null,
      sessionId: typeof record.session_id === "string" ? record.session_id : null,
    };
  } catch {
    return { aal: null, sessionId: null };
  }
}

/** True while an account with two-factor sign-in has a session that has not passed it (aal1). */
export function needsSecondFactor(user: Pick<User, "factors">, accessToken: string): boolean {
  return verifiedTotpFactor(user) !== null && readAccessTokenClaims(accessToken).aal !== "aal2";
}

/** Recovery codes: 12 letters and digits, shown as XXXX-XXXX-XXXX; case and dashes do not matter. */
export function normaliseRecoveryCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function looksLikeRecoveryCode(value: string): boolean {
  return /^[2-9A-HJ-NP-Z]{12}$/.test(normaliseRecoveryCode(value));
}

/** A six-digit authenticator code, spaces allowed (apps often show "123 456"). */
export function normaliseTotpCode(value: string): string {
  return value.replace(/\s/g, "");
}

export type TwoFactorFailure =
  "wrongCode" | "expired" | "tryLater" | "rateLimited" | "network" | "unknown";

/**
 * Turns a failed challenge or verification into a message key. The database refuses a challenge
 * after 10 attempts in 15 minutes and a code that was already accepted in the last 90 seconds;
 * Supabase Auth reports both as a server error, so they share "try again shortly".
 */
export function classifyTwoFactorError(error: unknown): TwoFactorFailure {
  if (isAuthError(error)) {
    if (error.status === 429 || error.code === "over_request_rate_limit") return "rateLimited";
    switch (error.code) {
      case "mfa_verification_failed":
      case "validation_failed":
        return "wrongCode";
      case "mfa_challenge_expired":
      case "mfa_factor_not_found":
        return "expired";
      default:
        break;
    }
    if (error.name === "AuthRetryableFetchError") return "network";
    if (error.status === 500) return "tryLater";
    return "unknown";
  }
  return error instanceof TypeError ? "network" : "unknown";
}
