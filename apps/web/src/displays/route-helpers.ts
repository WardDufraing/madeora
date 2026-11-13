import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";
import { getAuthState } from "@/auth/identity";

import { getDisplaySession } from "./server";

/** A JSON answer that no cache may keep. */
export function displayJson(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The checks of a display request before anything else (S43): same-origin JSON within the size
 * limit (CSRF; a cross-site page cannot make this browser ask for codes or burn the client's
 * throttle), and the body against `schema`. The body is never logged.
 */
export async function readDisplayRequest<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused) {
    return { ok: false, response: displayJson(refused.status, { error: refused.error }) };
  }
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: displayJson(body.status, { error: body.error }) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return { ok: false, response: displayJson(400, { error: "invalid" }) };
  return { ok: true, data: parsed.data };
}

/**
 * The paired display making this request (S44): its id from its own session (`display_me`), or the
 * answer to send instead: `401 not-paired` (no display session, revoked, Home closed) or
 * `503 unavailable`.
 */
export async function requireDisplay(): Promise<
  | { readonly ok: true; readonly displayId: string }
  | { readonly ok: false; readonly response: Response }
> {
  if ((await getAuthState()).kind !== "display") {
    return { ok: false, response: displayJson(401, { error: "not-paired" }) };
  }
  const result = await getDisplaySession();
  if (result.kind === "refused") {
    return { ok: false, response: displayJson(401, { error: "not-paired" }) };
  }
  if (result.kind === "unavailable") {
    return { ok: false, response: displayJson(503, { error: "unavailable" }) };
  }
  return { ok: true, displayId: result.session.displayId };
}
