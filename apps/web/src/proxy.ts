import { getPublicEnv } from "@madeora/config/env/public";
import { CORRELATION_HEADER, newCorrelationId } from "@madeora/observability";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { sessionCookieOptions } from "@/auth/cookie-options";
import { PATH_HEADER } from "@/auth/path-header";

/**
 * Runs before every page request (Next.js 16 "proxy", formerly middleware).
 *
 * 1. Refreshes an expiring Supabase session and writes the new cookies to both the request (for
 *    this render) and the response (for the browser), as `@supabase/ssr` requires. It does not
 *    decide access: pages confirm the identity with Supabase Auth themselves (`requireIdentity`).
 * 2. Marks every response `Cache-Control: private, no-store`, so no shared cache (CDN, proxy) can
 *    store one person's page and serve it to someone else (architecture.md §7, §9).
 * 3. Gives the request a fresh correlation ID (architecture.md §22), always generated here: one
 *    sent by the client is replaced, so nobody can choose the ID their requests are logged under.
 *    Route handlers read it with `requestCorrelationId`; the response carries it for support.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const env = getPublicEnv();
  const correlationId = newCorrelationId();

  const forward = (): NextResponse => {
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
    headers.set(CORRELATION_HEADER, correlationId);
    return NextResponse.next({ request: { headers } });
  };

  let response = forward();
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: sessionCookieOptions(env.NEXT_PUBLIC_APP_URL),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = forward();
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Reads the session from the cookies and refreshes it when it is about to expire. No other code
  // may run between creating the client and this call (supabase.com/docs/guides/auth/server-side).
  await supabase.auth.getSession();

  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set(CORRELATION_HEADER, correlationId);
  return response;
}

export const config = {
  // Every page and route handler; not Next.js build assets or the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
