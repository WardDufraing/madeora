import { getPublicEnv } from "@madeora/config/env/public";
import type { Database } from "@madeora/database";
import { createBrowserClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { sessionCookieOptions } from "./cookie-options";

/**
 * The browser's Supabase client (one per tab). Sign-in and email confirmation use it, so
 * Supabase Auth sees each person's own IP address for its rate limits (ADR 0007). It stores the
 * session in cookies, which the server reads and checks on every request.
 */
export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  const env = getPublicEnv();
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: sessionCookieOptions(env.NEXT_PUBLIC_APP_URL),
      isSingleton: true,
      // Never act on a `?code=` in the address by itself: the Google callback page (S08) decides
      // whether to exchange it, and a linking callback must not replace the current session.
      auth: { detectSessionInUrl: false },
    },
  );
}

type MemoryOnlyPurpose =
  "email-requests" | "password-reset" | "reauthentication" | "email-change" | "account-recovery";
const memoryOnlyClients = new Map<MemoryOnlyPurpose, SupabaseClient<Database>>();

/**
 * A client that keeps any session in this tab's memory only: no cookies, no storage, no refresh.
 *
 * - `email-requests`: sign-up, resending the confirmation and asking for a reset link. None of
 *   them signs anyone in, so they need no session cookies (and leave none behind).
 * - `password-reset`: the one-time session a reset link opens lives only here, so an unfinished
 *   reset never becomes a sign-in that the server or other tabs would accept. Reloading the page
 *   drops it; the person then asks for a new link.
 * - `reauthentication`: a fresh password sign-in that proves, just before linking or unlinking a
 *   sign-in method (S08) or any other sensitive change (S37), that the person at the keyboard
 *   knows the password (and has the authenticator). It is signed out again at once and never
 *   replaces the browser's own session.
 * - `email-change`: confirming a new account email from the link sent to it (S37). Supabase Auth
 *   answers with a session, which is signed out at once: opening the link must not sign anyone in.
 * - `account-recovery`: the signed-out recovery steps for a lost password and mailbox (S37). They
 *   run without any session, whoever is signed in to this browser.
 *
 * One client per purpose and tab, each under its own storage key, so they never share state or
 * cross-tab messages with each other or with the cookie client.
 */
export function getMemoryOnlySupabaseClient(purpose: MemoryOnlyPurpose): SupabaseClient<Database> {
  const existing = memoryOnlyClients.get(purpose);
  if (existing) return existing;
  const env = getPublicEnv();
  const client = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: `madeora-${purpose}`,
      },
    },
  );
  memoryOnlyClients.set(purpose, client);
  return client;
}

let googleReauthClient: SupabaseClient<Database> | null = null;

/**
 * The client for confirming a sensitive change with Google (S37), for accounts without a password.
 * The Google round trip leaves the page, so its PKCE verifier and the short-lived session it opens
 * live in this tab's sessionStorage, under their own key: never in the session cookies, so the
 * browser's own session is never replaced and the server never sees the extra one. The callback
 * signs it out as soon as the permission is granted.
 */
export function getGoogleReauthClient(): SupabaseClient<Database> {
  if (googleReauthClient) return googleReauthClient;
  const env = getPublicEnv();
  googleReauthClient = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        flowType: "pkce",
        persistSession: true,
        storage: window.sessionStorage,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "madeora-google-reauthentication",
      },
    },
  );
  return googleReauthClient;
}
