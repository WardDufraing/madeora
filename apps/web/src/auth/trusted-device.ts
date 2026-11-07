import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Trusted browsers (S37, spec "Confirmed optional adult two-factor authentication"): after the
 * second factor, the account holder may let this browser skip it for 30 days. The browser keeps a
 * random token in an httpOnly cookie, one per account; the database keeps only its hash, with the
 * browser and platform it was trusted on, and ends the trust after a password, email or
 * two-factor change, a reported session or "sign out everywhere"
 * (supabase/migrations/20261123090000_adult_security.sql).
 */

/** The cookie that holds this browser's trust token for one account. Names no account id. */
export function trustCookieName(userId: string): string {
  return `madeora-trust-${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;
}

/** 32 random bytes, base64url (43 characters). Never logged or shown. */
export function newTrustToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Options for the trust cookie: httpOnly, same-site lax, secure on https, until `expires`. */
export function trustCookieOptions(appUrl: string, expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: new URL(appUrl).protocol === "https:",
    path: "/",
    expires,
  };
}
