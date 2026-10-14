import { getPublicEnv } from "@madeora/config/env/public";
import { cookies } from "next/headers";

import { isSameOriginRequest } from "@/auth/same-origin";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * Signs this browser out: ends the session at Supabase Auth (its refresh token stops working) and
 * deletes the session cookies. A cookie-authenticated mutation, so cross-site requests are refused
 * (CSRF, architecture.md §7).
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request.headers, getPublicEnv().NEXT_PUBLIC_APP_URL)) {
    return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) {
    // Supabase Auth could not be reached, so it kept the session. Still delete this browser's
    // session cookies, so "signed out" is true on this device (the session then expires unused).
    const cookieStore = await cookies();
    for (const { name } of cookieStore.getAll()) {
      if (/^sb-.+-auth-token(?:\.\d+)?$/.test(name)) cookieStore.delete(name);
    }
  }
  // 303: the browser follows with a GET, so a reload never repeats the POST. A relative address
  // keeps the browser on the origin it used (`request.url` can name the server's own host instead).
  return new Response(null, {
    status: 303,
    headers: { Location: "/sign-in?status=signed-out", "Cache-Control": "no-store" },
  });
}
