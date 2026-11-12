import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getAuthState } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import type { ChildSignInErrorCode } from "./api";
import type { ChildSignInResult } from "./service";

/** A JSON answer that no cache may keep. */
function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function signInFailure(status: number, error: ChildSignInErrorCode): Response {
  return json(status, { error });
}

/**
 * The checks of a child sign-in request, before any secret is looked at: same-origin JSON within
 * the size limit (CSRF; a cross-site page cannot sign a child in or burn their tries), the body
 * against `schema`, and no adult signed in here (signing a child in would replace the adult's
 * session). A child already signed in here is signed out first. The body is never logged.
 */
export async function readSignInRequest<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused) return { ok: false, response: signInFailure(refused.status, refused.error) };
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: signInFailure(body.status, body.error) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) {
    // Same answer as a wrong secret: the shape of a guess is not worth a separate message.
    return { ok: false, response: signInFailure(401, "invalid-credentials") };
  }
  const state = await getAuthState();
  if (state.kind === "child") {
    await endChildSession();
  } else if (state.kind !== "signed-out") {
    return { ok: false, response: signInFailure(409, "signed-in") };
  }
  return { ok: true, data: parsed.data };
}

/** Ends this browser's child session in the database and in Supabase Auth. */
export async function endChildSession(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("child_end_session");
  if (error && error.code !== "42501" && error.code !== "PGRST301") {
    console.error(JSON.stringify({ event: "child_session.end_failed", code: error.code }));
  }
  await supabase.auth.signOut({ scope: "local" });
}

/** The HTTP answer for a sign-in result. */
export function signInResponse(result: ChildSignInResult): Response {
  switch (result.kind) {
    case "signed-in":
      return json(200, {});
    case "invalid":
      return signInFailure(401, "invalid-credentials");
    case "locked":
      return json(423, { error: "locked", until: result.until });
    case "rate-limited":
      return signInFailure(429, "rate-limited");
    case "not-enabled":
      return signInFailure(403, "not-enabled");
    case "device-not-approved":
      return signInFailure(403, "device-not-approved");
    case "unavailable":
      return signInFailure(503, "unavailable");
  }
}
