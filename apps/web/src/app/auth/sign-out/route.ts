import { getPublicEnv } from "@madeora/config/env/public";
import { cookies } from "next/headers";

import { isSameOriginRequest } from "@/auth/same-origin";
import { createSupabaseServerClient } from "@/auth/supabase-server";

/**
 * Signs this browser out: ends the session at Supabase Auth (its refresh token stops working) and
 * deletes the session cookies. A cookie-authenticated mutation, so cross-site requests are refused
 * (CSRF, architecture.md §7).
 *
 * S38 account switching posts `then=switch` (with the chosen remembered `account` id) or
 * `then=accounts` (removing the active account from this device's chooser); the destination
 * changes, the sign-out is the same. The next account always signs in on its own.
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
    headers: { Location: await destinationOf(request), "Cache-Control": "no-store" },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function destinationOf(request: Request): Promise<string> {
  let form: FormData | null = null;
  try {
    const type = request.headers.get("content-type") ?? "";
    if (
      type.startsWith("application/x-www-form-urlencoded") ||
      type.startsWith("multipart/form-data")
    ) {
      form = await request.formData();
    }
  } catch {
    form = null;
  }
  const then = form?.get("then");
  if (then === "accounts") return "/accounts?status=removed";
  if (then === "switch") {
    const account = form?.get("account");
    return typeof account === "string" && UUID.test(account)
      ? `/sign-in?status=switched&account=${account.toLowerCase()}`
      : "/sign-in?status=switched";
  }
  return "/sign-in?status=signed-out";
}
