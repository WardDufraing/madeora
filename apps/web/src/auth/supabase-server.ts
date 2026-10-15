import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";
import type { Database } from "@madeora/database";
import { CORRELATION_HEADER, isCorrelationId } from "@madeora/observability";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";

import { sessionCookieOptions } from "./cookie-options";

/**
 * A Supabase client acting as the person making this request, from their session cookies, so RLS
 * applies (architecture.md §6, §7). Create one per request; never share it between requests.
 * Server Components cannot set cookies; the proxy refreshes sessions before they render.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient<Database>> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const env = getPublicEnv();
  // The request's correlation ID (set by the proxy) goes along to the database, which stamps it on
  // the background jobs this request causes, so one incident can be followed end to end (S14).
  const correlationId = requestHeaders.get(CORRELATION_HEADER);
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      ...(isCorrelationId(correlationId)
        ? { global: { headers: { [CORRELATION_HEADER]: correlationId } } }
        : {}),
      cookieOptions: sessionCookieOptions(env.NEXT_PUBLIC_APP_URL),
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, which cannot set cookies. The proxy has already
            // refreshed the session for this request, so nothing is lost.
          }
        },
      },
    },
  );
}
