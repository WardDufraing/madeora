import { z } from "zod";

import { homeEndpoint } from "@/homes/api";
import { MemberActionError, sendMemberRequest } from "@/members/manage-api";

import type { DeviceChoreDone, DeviceChoreFailure } from "@/child-sign-in/api";

import type { DisplayBoard } from "./board";
import type { DisplayLayout, DisplayPreferences } from "./layout";
import type {
  ApproveDisplayInput,
  CheckCodeInput,
  DisplayLockStateInput,
  RenameDisplayInput,
} from "./schema";

/**
 * The HTTP contract of Household Display pairing (S43; versioned for later clients) and the
 * browser's callers for it. Same CSRF, content-type and size checks as the rest of `/api/v1`.
 *
 * The tablet (no session; refused with `409 signed-in` when any member, child or display session
 * is in this browser):
 * - `POST /api/v1/display/pairing` `{ renew }` → `200 { status: "pending", code, expiresAt }`,
 *   `200 { status: "expired" }`, or `200 { status: "paired" }` (the display session cookies are
 *   now set); `429 rate-limited`, `503 unavailable`. `renew: true` throws the current code away.
 *
 * The paired display:
 * - `POST /api/v1/display/heartbeat` `{}` → `200 { displayName, homeName, homeTimezone }`;
 *   `401 not-paired` (revoked, Home closed: go back to the pairing screen), `503 unavailable`.
 * - `POST /api/v1/display/reset` `{}` → `200 {}` after signing out a session the database no longer
 *   accepts; `409 paired` while it still works (a working display is never signed out here).
 * - `POST /api/v1/display/board` `{}` (S44) → `200 { board }` (what the display shows; while
 *   locked, the lock screen's fields only); `401 not-paired`, `503 unavailable`.
 * - `POST /api/v1/display/chores/complete` `{ occurrenceId, membershipId, pin }` (S44) →
 *   `200 { outcome: "completed" | "submitted", actionId }`; `401 invalid-pin | not-paired`,
 *   `423 locked { until }`, `409 pin-required | pin-not-set | already-done | steps-incomplete |
 *   display-locked | actions-off`, `403 not-eligible`, `429 rate-limited`, `503 unavailable`.
 * - `POST /api/v1/display/chores/undo` `{ actionId }` → `200 {}`; `409 expired | invalid`.
 * - `POST /api/v1/display/lock` `{ membershipId, pin }` (S44: a manager locks the display; there is
 *   no unlock here) → `200 {}`; `401 invalid-pin | not-paired`, `423 locked`, `409 pin-not-set`,
 *   `403 not-permitted`, `429 rate-limited`, `503 unavailable`.
 *
 * Home managers (Owner, or Administrator with manageHomeSettings; the database decides again):
 * - `POST /api/v1/homes/{homeId}/displays/check` `{ code }` → `200 { request: { id, deviceKind,
 *   browser, platform, requestedAt, expiresAt } }`; `404 invalid-code`, `409 expired`,
 *   `409 already-used`, `429 rate-limited`
 * - `POST /api/v1/homes/{homeId}/displays` `{ requestId, code, name }` → `201 { display: { id } }`;
 *   the same refusals and `429 limit-reached`
 * - `POST /api/v1/homes/{homeId}/displays/{displayId}/rename` `{ name }` → `200 {}`
 * - `POST /api/v1/homes/{homeId}/displays/{displayId}/revoke` `{}` → `200 {}`
 * - `POST /api/v1/homes/{homeId}/displays/{displayId}/config` `{ expectedRevision, layout,
 *   preferences }` (S44; `layout: null` restores the default) → `200 { revision }`;
 *   `409 { error: "conflict", revision }` when someone changed it meanwhile, `400 invalid`
 * - `POST /api/v1/homes/{homeId}/displays/{displayId}/lock` `{ locked, message }` (S44) → `200 {}`
 */

export const DISPLAY_PAIRING_ENDPOINT = "/api/v1/display/pairing";
export const DISPLAY_HEARTBEAT_ENDPOINT = "/api/v1/display/heartbeat";
export const DISPLAY_RESET_ENDPOINT = "/api/v1/display/reset";

export type PairingState =
  | { readonly status: "pending"; readonly code: string; readonly expiresAt: string }
  | { readonly status: "expired" }
  | { readonly status: "paired" }
  | { readonly status: "signed-in" }
  | { readonly status: "rate-limited" }
  | { readonly status: "unavailable" }
  | { readonly status: "network" };

const pairingBodySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), code: z.string(), expiresAt: z.string() }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("paired") }),
]);
const errorSchema = z.object({ error: z.string() });

async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

/** The tablet's pairing state, after resuming its code or (`renew`) asking for a new one. */
export async function requestPairing(renew: boolean): Promise<PairingState> {
  const response = await post(DISPLAY_PAIRING_ENDPOINT, { renew });
  if (!response) return { status: "network" };
  const body: unknown = await response.json().catch(() => ({}));
  if (response.ok) {
    const parsed = pairingBodySchema.safeParse(body);
    return parsed.success ? parsed.data : { status: "unavailable" };
  }
  const error = errorSchema.safeParse(body);
  if (error.success && error.data.error === "rate-limited") return { status: "rate-limited" };
  if (error.success && error.data.error === "signed-in") return { status: "signed-in" };
  return { status: "unavailable" };
}

export type HeartbeatResult = "ok" | "not-paired" | "offline";

/** Whether the server still accepts this display (`offline`: it could not be asked). */
export async function sendHeartbeat(): Promise<HeartbeatResult> {
  const response = await post(DISPLAY_HEARTBEAT_ENDPOINT, {});
  if (!response) return "offline";
  if (response.ok) return "ok";
  return response.status === 401 ? "not-paired" : "offline";
}

/** Signs out a display session the server no longer accepts. */
export async function resetDisplay(): Promise<boolean> {
  const response = await post(DISPLAY_RESET_ENDPOINT, {});
  return response?.ok ?? false;
}

// Home managers ---------------------------------------------------------------------------------

export function displaysEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/displays`;
}

export interface PairingReview {
  readonly id: string;
  readonly deviceKind: string;
  readonly browser: string;
  readonly platform: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

const reviewSchema = z.object({
  request: z.object({
    id: z.uuid(),
    deviceKind: z.string(),
    browser: z.string(),
    platform: z.string(),
    requestedAt: z.string(),
    expiresAt: z.string(),
  }),
});

export async function checkPairingCode(
  homeId: string,
  input: CheckCodeInput,
): Promise<PairingReview> {
  const parsed = reviewSchema.safeParse(
    await sendMemberRequest("POST", `${displaysEndpoint(homeId)}/check`, input),
  );
  if (!parsed.success) throw new MemberActionError("failed");
  return parsed.data.request;
}

export async function approveDisplay(homeId: string, input: ApproveDisplayInput): Promise<void> {
  await sendMemberRequest("POST", displaysEndpoint(homeId), input);
}

export async function renameDisplay(
  homeId: string,
  displayId: string,
  input: RenameDisplayInput,
): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${displaysEndpoint(homeId)}/${encodeURIComponent(displayId)}/rename`,
    input,
  );
}

export async function revokeDisplay(homeId: string, displayId: string): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${displaysEndpoint(homeId)}/${encodeURIComponent(displayId)}/revoke`,
    {},
  );
}

// The paired display (S44) -------------------------------------------------------------------------

export const DISPLAY_BOARD_ENDPOINT = "/api/v1/display/board";
export const DISPLAY_CHORE_COMPLETE_ENDPOINT = "/api/v1/display/chores/complete";
export const DISPLAY_CHORE_UNDO_ENDPOINT = "/api/v1/display/chores/undo";
export const DISPLAY_LOCK_ENDPOINT = "/api/v1/display/lock";

export type BoardReadResult =
  | { readonly kind: "ok"; readonly board: DisplayBoard }
  | { readonly kind: "not-paired" }
  | { readonly kind: "offline" };

/**
 * The display's board as the server sends it. Only its outer shape is checked here: the server
 * built it from the database's checked answer, and the screen reads each field defensively.
 */
const boardResponseSchema = z.object({
  board: z.custom<DisplayBoard>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "locked" in value &&
      typeof value.locked === "boolean",
  ),
});

/** Reads what this display shows (`offline`: the server could not be asked or answered oddly). */
export async function readDisplayBoard(): Promise<BoardReadResult> {
  const response = await post(DISPLAY_BOARD_ENDPOINT, {});
  if (!response) return { kind: "offline" };
  if (response.status === 401) return { kind: "not-paired" };
  if (!response.ok) return { kind: "offline" };
  const parsed = boardResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { kind: "ok", board: parsed.data.board } : { kind: "offline" };
}

const displayFailureByCode: Record<string, Exclude<DeviceChoreFailure["kind"], "locked">> = {
  "invalid-pin": "invalidPin",
  "pin-required": "pinRequired",
  "pin-not-set": "pinNotSet",
  "already-done": "alreadyDone",
  "steps-incomplete": "stepsIncomplete",
  "not-eligible": "notEligible",
  "rate-limited": "rateLimited",
};

const choreDoneSchema = z.object({
  outcome: z.enum(["completed", "submitted"]),
  actionId: z.uuid(),
});
const errorBodySchema = z.object({ error: z.string(), until: z.string().nullable().optional() });

/** Completes a chore on this display (same answers as a household device's). */
export async function completeChoreOnDisplay(input: {
  readonly occurrenceId: string;
  readonly membershipId: string;
  readonly pin: string | null;
}): Promise<DeviceChoreDone | DeviceChoreFailure> {
  const response = await post(DISPLAY_CHORE_COMPLETE_ENDPOINT, input);
  if (!response) return { kind: "network" };
  const body: unknown = await response.json().catch(() => ({}));
  if (response.ok) {
    const done = choreDoneSchema.safeParse(body);
    return done.success ? done.data : { kind: "failed" };
  }
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) return { kind: "failed" };
  if (parsed.data.error === "locked") return { kind: "locked", until: parsed.data.until ?? null };
  return { kind: displayFailureByCode[parsed.data.error] ?? "failed" };
}

/** `true` when undone; `false` when it is too late or not possible. */
export async function undoChoreOnDisplay(actionId: string): Promise<boolean> {
  const response = await post(DISPLAY_CHORE_UNDO_ENDPOINT, { actionId });
  return response?.ok ?? false;
}

export type DisplayLockFailure =
  "invalidPin" | "pinLocked" | "pinNotSet" | "notPermitted" | "rateLimited" | "network" | "failed";

const lockFailureByCode: Record<string, DisplayLockFailure> = {
  "invalid-pin": "invalidPin",
  locked: "pinLocked",
  "pin-not-set": "pinNotSet",
  "not-permitted": "notPermitted",
  "rate-limited": "rateLimited",
};

/** A manager locks this display with their own PIN; `null` when it is locked now. */
export async function lockThisDisplay(input: {
  readonly membershipId: string;
  readonly pin: string;
}): Promise<DisplayLockFailure | null> {
  const response = await post(DISPLAY_LOCK_ENDPOINT, input);
  if (!response) return "network";
  if (response.ok) return null;
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => ({})));
  return (parsed.success ? lockFailureByCode[parsed.data.error] : undefined) ?? "failed";
}

// A display's configuration, for Home managers (S44) ---------------------------------------------

export type SaveConfigResult =
  | { readonly kind: "saved"; readonly revision: number }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "failed";
      readonly failure:
        "signedOut" | "notPermitted" | "notFound" | "invalid" | "network" | "failed";
    };

const savedSchema = z.object({ revision: z.number().int() });

/** Saves one display's layout and presentation (`layout: null`: the default layout). */
export async function saveDisplayConfig(
  homeId: string,
  displayId: string,
  input: {
    readonly expectedRevision: number;
    readonly layout: DisplayLayout | null;
    readonly preferences: DisplayPreferences;
  },
): Promise<SaveConfigResult> {
  const response = await post(
    `${displaysEndpoint(homeId)}/${encodeURIComponent(displayId)}/config`,
    input,
  );
  if (!response) return { kind: "failed", failure: "network" };
  const body: unknown = await response.json().catch(() => ({}));
  if (response.ok) {
    const parsed = savedSchema.safeParse(body);
    return parsed.success
      ? { kind: "saved", revision: parsed.data.revision }
      : { kind: "failed", failure: "failed" };
  }
  const error = errorSchema.safeParse(body);
  const code = error.success ? error.data.error : "";
  if (code === "conflict") return { kind: "conflict" };
  if (response.status === 401) return { kind: "failed", failure: "signedOut" };
  if (code === "not-permitted") return { kind: "failed", failure: "notPermitted" };
  if (code === "not-found") return { kind: "failed", failure: "notFound" };
  if (code === "invalid") return { kind: "failed", failure: "invalid" };
  return { kind: "failed", failure: "failed" };
}

/** Locks or unlocks one display from the manager's own session, with its welcome message. */
export async function setDisplayLock(
  homeId: string,
  displayId: string,
  input: DisplayLockStateInput,
): Promise<void> {
  await sendMemberRequest(
    "POST",
    `${displaysEndpoint(homeId)}/${encodeURIComponent(displayId)}/lock`,
    input,
  );
}
