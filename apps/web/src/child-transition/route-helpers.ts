import "server-only";

import type { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";

/** A JSON answer that no cache may keep. */
export function noStoreJson(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The checks of a request that needs no session (S42 part 3): same-origin JSON within the size
 * limit (CSRF) and the body against `schema`. The body is never logged.
 */
export async function readOpenRequest<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused)
    return { ok: false, response: noStoreJson(refused.status, { error: refused.error }) };
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: noStoreJson(body.status, { error: body.error }) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return { ok: false, response: noStoreJson(400, { error: "invalid" }) };
  return { ok: true, data: parsed.data };
}
