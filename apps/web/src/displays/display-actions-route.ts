import "server-only";

import { z } from "zod";

import { enteredPinSchema } from "@/child-sign-in/schema";

import type { DisplayChoreResult, DisplayLockResult } from "./display-actions";
import { displayJson } from "./route-helpers";

/** Request bodies of the display's actions (S44). */
export const displayCompleteSchema = z.strictObject({
  occurrenceId: z.uuid(),
  membershipId: z.uuid(),
  pin: enteredPinSchema.nullable(),
});
export const displayUndoSchema = z.strictObject({ actionId: z.uuid() });
export const displayLockSchema = z.strictObject({ membershipId: z.uuid(), pin: enteredPinSchema });

/** The HTTP answer for a chore completed on a display. */
export function displayChoreResponse(result: DisplayChoreResult): Response {
  switch (result.kind) {
    case "completed":
    case "submitted":
      return displayJson(200, { outcome: result.kind, actionId: result.actionId });
    case "locked":
      return displayJson(423, { error: "locked", until: result.until });
    case "invalid-pin":
      return displayJson(401, { error: "invalid-pin" });
    case "not-paired":
      return displayJson(401, { error: "not-paired" });
    case "pin-required":
    case "pin-not-set":
    case "already-done":
    case "steps-incomplete":
    case "display-locked":
    case "actions-off":
      return displayJson(409, { error: result.kind });
    case "not-eligible":
      return displayJson(403, { error: "not-eligible" });
    case "rate-limited":
      return displayJson(429, { error: "rate-limited" });
    case "unavailable":
      return displayJson(503, { error: "unavailable" });
  }
}

/** The HTTP answer for locking a display on the display. */
export function displayLockResponse(result: DisplayLockResult): Response {
  switch (result.kind) {
    case "locked-now":
    case "already-locked":
      return displayJson(200, {});
    case "pin-locked":
      return displayJson(423, { error: "locked", until: result.until });
    case "invalid-pin":
      return displayJson(401, { error: "invalid-pin" });
    case "not-paired":
      return displayJson(401, { error: "not-paired" });
    case "pin-not-set":
      return displayJson(409, { error: "pin-not-set" });
    case "not-permitted":
      return displayJson(403, { error: "not-permitted" });
    case "rate-limited":
      return displayJson(429, { error: "rate-limited" });
    case "unavailable":
      return displayJson(503, { error: "unavailable" });
  }
}
