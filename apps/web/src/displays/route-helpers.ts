import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";

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
