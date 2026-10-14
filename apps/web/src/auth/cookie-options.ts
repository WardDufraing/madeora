import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Session cookie settings shared by the browser, server and proxy clients, so all three read and
 * write the same cookie. `SameSite=Lax` keeps the cookie off cross-site POSTs; `Secure` whenever
 * the app runs on https. The cookie cannot be HttpOnly: sign-in runs in the browser (see ADR 0007).
 */
export function sessionCookieOptions(appUrl: string): CookieOptionsWithName {
  return {
    path: "/",
    sameSite: "lax",
    secure: new URL(appUrl).protocol === "https:",
  };
}
