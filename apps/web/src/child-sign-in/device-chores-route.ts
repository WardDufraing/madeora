import "server-only";

import { z } from "zod";

import { checkJsonMutation, readJsonBody } from "@/api/json-request";

import { currentDeviceHash } from "./device";
import type { DeviceChoreResult } from "./device-chores";
import { enteredPinSchema } from "./schema";

/**
 * The checks of a household-device chore request (S42 part 2): same-origin JSON within the size
 * limit (CSRF), the body against `schema`, and this browser's approved-device cookie. Nobody needs
 * to be signed in; the body is never logged.
 */
export async function readDeviceRequest<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly data: z.output<S>; readonly deviceHash: string }
  | { readonly ok: false; readonly response: Response }
> {
  const refused = checkJsonMutation(request, maxBytes);
  if (refused) return { ok: false, response: deviceJson(refused.status, { error: refused.error }) };
  const body = await readJsonBody(request, maxBytes);
  if (!body.ok) return { ok: false, response: deviceJson(body.status, { error: body.error }) };
  const parsed = schema.safeParse(body.body);
  if (!parsed.success) return { ok: false, response: deviceJson(400, { error: "invalid" }) };
  const deviceHash = await currentDeviceHash();
  if (!deviceHash) {
    return { ok: false, response: deviceJson(403, { error: "device-not-approved" }) };
  }
  return { ok: true, data: parsed.data, deviceHash };
}

export function deviceJson(status: number, body: object): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const deviceCompleteSchema = z.strictObject({
  occurrenceId: z.uuid(),
  membershipId: z.uuid(),
  pin: enteredPinSchema.nullable(),
});
export const deviceUndoSchema = z.strictObject({ actionId: z.uuid() });

/** The HTTP answer for a device completion. */
export function deviceChoreResponse(result: DeviceChoreResult): Response {
  switch (result.kind) {
    case "completed":
    case "submitted":
      return deviceJson(200, { outcome: result.kind, actionId: result.actionId });
    case "locked":
      return deviceJson(423, { error: "locked", until: result.until });
    case "invalid-pin":
      return deviceJson(401, { error: "invalid-pin" });
    case "pin-required":
    case "pin-not-set":
    case "already-done":
    case "steps-incomplete":
      return deviceJson(409, { error: result.kind });
    case "not-eligible":
    case "device-not-approved":
      return deviceJson(403, { error: result.kind });
    case "rate-limited":
      return deviceJson(429, { error: "rate-limited" });
    case "unavailable":
      return deviceJson(503, { error: "unavailable" });
  }
}
